import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reviewDue, unmetPrereqs, frontier, nextLessons, analogies, workingSet, authorAffinity,
} from '../src/queries/queries.js';
import { buildEdges } from '../src/graph/graph.js';
import { EmbeddingIndex } from '../src/embeddings/index.js';
import { FakeProvider } from '../src/embeddings/provider.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page, StudentState } from '../src/types.js';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const NOW = d('2026-07-10');

const pages = new Map<string, Page>([
  ['derivatives', parsePage('derivatives', '', '---\ntitle: Derivatives\ndifficulty: 1\n---\nrates of change of functions')],
  ['chain-rule', parsePage('chain-rule', '', '---\ntitle: Chain Rule\nprereqs: [derivatives]\ndifficulty: 2\n---\nderivative of composed functions rates of change')],
  ['backprop', parsePage('backprop', '', '---\ntitle: Backpropagation\nprereqs: [chain-rule]\ndifficulty: 3\n---\ngradients composed backwards through layers')],
  ['kelly', parsePage('kelly', '', '---\ntitle: Kelly Criterion\ndifficulty: 4\n---\nbet sizing by iterative fraction optimization')],
]);

const mastery = (level: any, last: string) => ({ level, evidence: [], misconceptions: [], last_reinforced: last });

// Fixture edges: chain-rule -> derivatives (prereq), backprop -> chain-rule (prereq); kelly isolated.
const edges = buildEdges(pages);

// Mastery WITH evidence, which workingSet seeds require. Single-date entries keep the stability
// factor at 1, so decay expectations stay on the base windows.
const evd = (level: any, dates: string[], misconceptions: string[] = []) => ({
  level,
  evidence: dates.map((date) => ({ date, kind: 'applied-correctly' as const, note: 'x' })),
  misconceptions,
  last_reinforced: dates[dates.length - 1],
});

let index: EmbeddingIndex;
beforeAll(async () => {
  index = new EmbeddingIndex(mkdtempSync(join(tmpdir(), 'lw-q-')), new FakeProvider());
  await index.sync(pages);
});

describe('queries', () => {
  it('reviewDue finds decayed pages only', () => {
    const state: StudentState = {
      derivatives: mastery('mastered', '2026-05-01'), // decayed
      'chain-rule': mastery('practicing', '2026-07-01'), // fresh
    };
    const due = reviewDue(state, pages, NOW);
    expect(due.map((s) => s.slug)).toEqual(['derivatives']);
    expect(due[0].reason).toBe('review-due');
  });

  it('reviewDue orders by how far past its decay window each page has slipped', () => {
    // chain-rule is FIRST in insertion order but least overdue; the sort must win over that so
    // nextLessons' top-2 review slots go to the pages slipping hardest.
    const state: StudentState = {
      'chain-rule': mastery('mastered', '2026-05-20'),    // 51d stale, 45d window -> ~6 overdue
      derivatives: mastery('practicing', '2026-05-01'),   // 70d stale, 21d window -> ~49 overdue
      kelly: mastery('practicing', '2026-06-01'),         // 39d stale, 21d window -> ~18 overdue
    };
    const due = reviewDue(state, pages, NOW);
    expect(due.map((s) => s.slug)).toEqual(['derivatives', 'kelly', 'chain-rule']);
  });

  it('unmetPrereqs walks the chain deepest-first', () => {
    const gaps = unmetPrereqs('backprop', pages, {}, NOW);
    expect(gaps.map((g) => g.slug)).toEqual(['derivatives', 'chain-rule']);
    expect(gaps[0].reason).toBe('unmet-prereq');
  });

  it('frontier only offers pages whose prereqs are known', () => {
    const state: StudentState = { derivatives: mastery('practicing', '2026-07-01') };
    const f = frontier(state, pages, index, NOW, 5);
    const slugs = f.map((s) => s.slug);
    expect(slugs).toContain('chain-rule'); // prereq (derivatives) known
    expect(slugs).not.toContain('backprop'); // chain-rule not known
    expect(slugs).not.toContain('derivatives'); // already known
  });

  it('nextLessons: goal mode = review + prereq gaps, deduped and capped', () => {
    const state: StudentState = { derivatives: mastery('mastered', '2026-05-01') };
    const out = nextLessons(state, pages, index, NOW, 'backprop', 3);
    expect(out[0]).toMatchObject({ slug: 'derivatives', reason: 'review-due' });
    expect(out.map((s) => s.slug)).toContain('chain-rule');
    expect(out.length).toBeLessThanOrEqual(3);
    const seen = new Set(out.map((s) => s.slug));
    expect(seen.size).toBe(out.length); // deduped
  });

  it('analogies rank known pages by similarity to the target', () => {
    const state: StudentState = {
      derivatives: mastery('practicing', '2026-07-01'),
      'chain-rule': mastery('mastered', '2026-07-01'),
    };
    const a = analogies('backprop', state, pages, index, NOW, 2);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((x) => ['derivatives', 'chain-rule'].includes(x.slug))).toBe(true);
    expect(analogies('backprop', state, pages, null, NOW)).toEqual([]);
  });
});

describe('workingSet', () => {
  it('ranks seeds by freshest evidence, slug ascending on ties, and skips slugs with no page', () => {
    const state: StudentState = {
      derivatives: evd('practicing', ['2026-07-01']),
      kelly: evd('practicing', ['2026-07-05']),
      'chain-rule': evd('practicing', ['2026-06-01', '2026-07-05']), // max date wins, not the first
      backprop: evd('practicing', ['2026-06-01']),
      ghost: evd('practicing', ['2026-07-09']), // no such page — never a seed
    };
    const ws = workingSet(state, pages, edges, NOW, 8);
    expect(ws.filter((m) => m.why === 'recent-evidence').map((m) => m.slug))
      .toEqual(['chain-rule', 'kelly', 'derivatives', 'backprop']);
    expect(ws.map((m) => m.slug)).not.toContain('ghost');
  });

  it('caps seeds at ceil(k/2) and the whole set at k', () => {
    const state: StudentState = {
      derivatives: evd('practicing', ['2026-07-01']),
      kelly: evd('practicing', ['2026-07-05']),
      'chain-rule': evd('practicing', ['2026-07-05']),
      backprop: evd('practicing', ['2026-06-01']),
    };
    const ws = workingSet(state, pages, edges, NOW, 3);
    expect(ws).toHaveLength(3);
    // ceil(3/2) = 2 seeds (chain-rule, kelly); the one remaining slot goes to the top seed's
    // first neighbor in slug order.
    expect(ws.map((m) => [m.slug, m.why])).toEqual([
      ['chain-rule', 'recent-evidence'],
      ['kelly', 'recent-evidence'],
      ['backprop', 'neighbor:chain-rule'],
    ]);
  });

  it('expands 1 hop over BOTH edge directions, tags each neighbor with its seed, slug ascending', () => {
    const state: StudentState = { 'chain-rule': evd('practicing', ['2026-07-01']) };
    const ws = workingSet(state, pages, edges, NOW, 10);
    // backprop reaches chain-rule via an INBOUND prereq edge, derivatives via an outbound one.
    expect(ws.map((m) => [m.slug, m.why])).toEqual([
      ['chain-rule', 'recent-evidence'],
      ['backprop', 'neighbor:chain-rule'],
      ['derivatives', 'neighbor:chain-rule'],
    ]);
    // A pulled-in neighbor the student never touched reads as exactly that.
    expect(ws[1]).toMatchObject({ level: 'unseen', effective: 'unseen', lastEvidence: null, due: false });
  });

  it('flags decayed pages as due, fresh ones not', () => {
    const state: StudentState = {
      derivatives: evd('mastered', ['2026-05-01']), // 70d stale > 45d window -> practicing
      kelly: evd('practicing', ['2026-07-05']),
    };
    const bySlug = Object.fromEntries(workingSet(state, pages, edges, NOW, 4).map((m) => [m.slug, m]));
    expect(bySlug.derivatives).toMatchObject({ level: 'mastered', effective: 'practicing', due: true });
    expect(bySlug.kelly.due).toBe(false);
  });

  it('includes the misconception count only when non-zero', () => {
    const state: StudentState = {
      derivatives: evd('practicing', ['2026-07-01'], ['thinks dy/dx is a fraction']),
      kelly: evd('practicing', ['2026-07-01']),
    };
    const bySlug = Object.fromEntries(workingSet(state, pages, edges, NOW, 4).map((m) => [m.slug, m]));
    expect(bySlug.derivatives.misconceptions).toBe(1);
    expect(bySlug.kelly).not.toHaveProperty('misconceptions');
  });

  it('returns empty members for a student with no evidence — mastery rows alone do not seed', () => {
    expect(workingSet({}, pages, edges, NOW, 20)).toEqual([]);
    expect(workingSet({ derivatives: mastery('exposed', '2026-07-01') }, pages, edges, NOW, 20)).toEqual([]);
  });

  it('is deterministic: two calls, byte-identical JSON', () => {
    const state: StudentState = {
      derivatives: evd('mastered', ['2026-05-01']),
      'chain-rule': evd('practicing', ['2026-07-05'], ['x']),
      kelly: evd('practicing', ['2026-07-05']),
    };
    const a = JSON.stringify(workingSet(state, pages, edges, NOW, 20));
    const b = JSON.stringify(workingSet(state, pages, edges, NOW, 20));
    expect(b).toBe(a);
  });
});

describe('authorAffinity — who the learner has actually learned from', () => {
  const page = (slug: string, authors: string[]) =>
    parsePage(slug, '', `---\ntitle: ${slug}\nauthors: ${JSON.stringify(authors)}\n---\nbody`);
  const ev = (kind: string, date: string) => ({ kind, date, note: '' } as any);
  const byAuthorPages = new Map<string, Page>([
    ['a1', page('a1', ['Strogatz'])],
    ['a2', page('a2', ['Strogatz'])],
    ['b1', page('b1', ['Sanderson'])],
    ['c1', page('c1', [])], // no credited author — cannot appear in the report
  ]);

  it('counts proven evidence and struggles per author, most-proven first', () => {
    const state = {
      a1: { level: 'practicing', evidence: [ev('applied-correctly', '2026-07-01'), ev('struggled', '2026-06-01')], misconceptions: [] },
      a2: { level: 'exposed', evidence: [ev('explained-correctly', '2026-07-05')], misconceptions: [] },
      b1: { level: 'exposed', evidence: [ev('struggled', '2026-07-02')], misconceptions: [] },
    } as unknown as StudentState;
    const out = authorAffinity(state, byAuthorPages);
    expect(out.map((a) => a.author)).toEqual(['Strogatz', 'Sanderson']); // proven volume orders
    const [strogatz, sanderson] = out;
    expect(strogatz).toMatchObject({ pages: 2, proven: 2, provenEvidence: 2, struggles: 1, lastEvidence: '2026-07-05' });
    // An author whose material is NOT landing still appears — the struggle is the point.
    expect(sanderson).toMatchObject({ pages: 1, proven: 0, provenEvidence: 0, struggles: 1 });
  });

  it('an author with pages but no evidence reports zeros rather than vanishing', () => {
    const out = authorAffinity({} as StudentState, byAuthorPages);
    expect(out.map((a) => a.author).sort()).toEqual(['Sanderson', 'Strogatz']);
    expect(out.every((a) => a.provenEvidence === 0 && a.lastEvidence === null)).toBe(true);
  });

  it('is a fact about material in the vault — an uncredited page credits nobody', () => {
    const out = authorAffinity({} as StudentState, new Map([['c1', page('c1', [])]]));
    expect(out).toEqual([]);
  });
});
