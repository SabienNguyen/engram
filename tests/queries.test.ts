import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reviewDue, unmetPrereqs, frontier, nextLessons, analogies,
} from '../src/queries/queries.js';
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
