import { daysOverdue, effectiveLevel, isKnown } from '../student/model.js';
import type { EmbeddingIndex } from '../embeddings/index.js';
import type {
  Edge, LessonSuggestion, Page, PageMastery, StudentState, WorkingSetMember,
} from '../types.js';

function title(pages: Map<string, Page>, slug: string): string {
  return pages.get(slug)?.meta.title ?? slug;
}

function knownSlugs(state: StudentState, pages: Map<string, Page>, now: Date): string[] {
  return [...pages.keys()].filter((slug) => isKnown(effectiveLevel(state[slug], now)));
}

export function reviewDue(
  state: StudentState, pages: Map<string, Page>, now: Date
): LessonSuggestion[] {
  const out: LessonSuggestion[] = [];
  for (const [slug, m] of Object.entries(state)) {
    if (!pages.has(slug)) continue;
    const eff = effectiveLevel(m, now);
    if (eff !== m.level) {
      out.push({
        slug, title: title(pages, slug), reason: 'review-due',
        detail: `stored ${m.level}, decayed to ${eff}`,
      });
    }
  }
  // Most overdue first, so nextLessons' top-2 review slots are the pages slipping hardest rather
  // than whichever the state object happened to enumerate first.
  return out.sort((a, b) => daysOverdue(state[b.slug], now) - daysOverdue(state[a.slug], now));
}

export function unmetPrereqs(
  goal: string, pages: Map<string, Page>, state: StudentState, now: Date
): LessonSuggestion[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (slug: string) => {
    if (visited.has(slug)) return;
    visited.add(slug);
    for (const pre of pages.get(slug)?.meta.prereqs ?? []) visit(pre);
    if (slug !== goal && pages.has(slug) && !isKnown(effectiveLevel(state[slug], now))) {
      ordered.push(slug);
    }
  };
  visit(goal);
  return ordered.map((slug) => ({
    slug, title: title(pages, slug), reason: 'unmet-prereq' as const, detail: `needed for ${goal}`,
  }));
}

export function frontier(
  state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null,
  now: Date, k: number
): LessonSuggestion[] {
  const candidates = [...pages.values()].filter((p) => {
    const eff = effectiveLevel(state[p.slug], now);
    if (eff !== 'unseen' && eff !== 'exposed') return false;
    return p.meta.prereqs.every(
      (pre) => !pages.has(pre) || isKnown(effectiveLevel(state[pre], now))
    );
  });
  const known = knownSlugs(state, pages, now);
  if (index && known.length) {
    const eligible = new Set(candidates.map((c) => c.slug));
    return index
      .similarToMany(known, k, (slug) => eligible.has(slug))
      .map(({ slug, score }) => ({
        slug, title: title(pages, slug), reason: 'frontier' as const,
        detail: `near your known region (score ${score.toFixed(2)})`,
      }));
  }
  return candidates
    .sort((a, b) => a.meta.difficulty - b.meta.difficulty)
    .slice(0, k)
    .map((p) => ({
      slug: p.slug, title: p.meta.title, reason: 'frontier' as const,
      detail: `easiest unexplored (difficulty ${p.meta.difficulty})`,
    }));
}

export function nextLessons(
  state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null,
  now: Date, goal?: string, k = 3
): LessonSuggestion[] {
  const combined = [
    ...reviewDue(state, pages, now).slice(0, 2),
    ...(goal ? unmetPrereqs(goal, pages, state, now) : frontier(state, pages, index, now, k)),
  ];
  const seen = new Set<string>();
  return combined.filter((s) => !seen.has(s.slug) && seen.add(s.slug)).slice(0, k);
}

/** The recently-exercised region of the vault: the ceil(k/2) evidenced pages with the freshest
 *  evidence (tiebreak: slug asc), then their 1-hop graph neighbors — any edge type, both
 *  directions — filling the remaining slots in seed-rank order, each tagged with the seed that
 *  pulled it in. Pure function of (state, pages, edges, now): no embeddings, no randomness, so
 *  identical inputs give byte-identical output — what lets a harness consult it before any full
 *  search and cache the answer. */
export function workingSet(
  state: StudentState, pages: Map<string, Page>, edges: Edge[], now: Date, k: number
): WorkingSetMember[] {
  // Evidence is appended chronologically by applyEvidence, but take the max rather than the last
  // entry so a hand-edited or merged student file still ranks correctly.
  const latest = (m: PageMastery) => m.evidence.reduce((a, e) => (e.date > a ? e.date : a), '');
  const member = (slug: string, why: WorkingSetMember['why']): WorkingSetMember => {
    const m = state[slug];
    const level = m?.level ?? 'unseen';
    const effective = effectiveLevel(m, now);
    const mis = m?.misconceptions.length ?? 0;
    return {
      slug, title: title(pages, slug), level, effective,
      lastEvidence: m && m.evidence.length ? latest(m) : null,
      due: effective !== level, why,
      ...(mis > 0 ? { misconceptions: mis } : {}),
    };
  };
  const seeds = Object.entries(state)
    .filter(([slug, m]) => pages.has(slug) && m.evidence.length > 0)
    .map(([slug, m]) => ({ slug, last: latest(m) }))
    // Plain string comparison, not localeCompare: ISO dates order lexicographically and slug order
    // must not depend on the host locale. Slugs are unique, so no equal case.
    .sort((a, b) => (a.last === b.last ? (a.slug < b.slug ? -1 : 1) : a.last < b.last ? 1 : -1))
    .slice(0, Math.ceil(k / 2));
  const out = seeds.map((s) => member(s.slug, 'recent-evidence'));
  const taken = new Set(seeds.map((s) => s.slug));
  for (const s of seeds) {
    if (out.length >= k) break;
    const near = new Set<string>();
    for (const e of edges) {
      if (e.src === s.slug) near.add(e.dst);
      else if (e.dst === s.slug) near.add(e.src);
    }
    for (const n of [...near].sort()) {
      if (out.length >= k) break;
      // A dangling edge target (frontmatter naming a page never written) has no title or body to
      // teach from — skip it rather than emit a member the caller cannot read.
      if (taken.has(n) || !pages.has(n)) continue;
      taken.add(n);
      out.push(member(n, `neighbor:${s.slug}`));
    }
  }
  return out;
}

export function analogies(
  slug: string, state: StudentState, pages: Map<string, Page>,
  index: EmbeddingIndex | null, now: Date, k = 3
): { slug: string; title: string; score: number }[] {
  if (!index) return [];
  const known = new Set(knownSlugs(state, pages, now));
  return index
    .similarTo(slug, k, (s) => known.has(s))
    .map(({ slug: s, score }) => ({ slug: s, title: title(pages, s), score }));
}

/** One author the learner has material from, with what that material has actually produced. */
export interface AuthorAffinity {
  author: string;
  /** Pages compiled from this author's material that are in the vault. */
  pages: number;
  /** Of those, how many the learner has proven at all (any positive evidence). */
  proven: number;
  /** Positive evidence entries across this author's pages — the "you learned from this person"
   *  signal, counted rather than scored so the number means one checkable thing. */
  provenEvidence: number;
  /** Struggles and misconceptions across them — shown beside `proven` so an author whose material
   *  is not landing is visible too, rather than ranked purely by volume. */
  struggles: number;
  /** Most recent evidence date on any of this author's pages, ISO, or null if never exercised. */
  lastEvidence: string | null;
}

const POSITIVE = new Set(['explained-correctly', 'applied-correctly', 'rubric-passed']);

/**
 * Which authors the learner has actually learned from, derived — never declared.
 *
 * The principle (3blue1brown's, and this app's): you choose material by WHO made it, and the
 * evidence that an author suits you is that their material produced proven learning, not that you
 * said you liked them. So this counts real evidence on the pages compiled from each author's
 * source and reports the struggles alongside, leaving the judgement to the caller. Authors with no
 * pages in the vault cannot appear: affinity is a fact about material you have, not a preference
 * store.
 */
export function authorAffinity(
  state: StudentState, pages: Map<string, Page>,
): AuthorAffinity[] {
  const byAuthor = new Map<string, AuthorAffinity>();
  for (const page of pages.values()) {
    for (const author of page.meta.authors) {
      const a = byAuthor.get(author) ?? {
        author, pages: 0, proven: 0, provenEvidence: 0, struggles: 0, lastEvidence: null,
      };
      a.pages++;
      const mastery = state[page.slug];
      if (mastery) {
        let positive = 0;
        for (const e of mastery.evidence) {
          if (POSITIVE.has(e.kind)) positive++;
          else if (e.kind === 'struggled' || e.kind === 'misconception') a.struggles++;
          if (a.lastEvidence === null || e.date > a.lastEvidence) a.lastEvidence = e.date;
        }
        a.provenEvidence += positive;
        if (positive > 0) a.proven++;
      }
      byAuthor.set(author, a);
    }
  }
  // Most-proven first, then most material — the order a "read more by…" caller wants; ties break
  // on name so the list is stable across calls.
  return [...byAuthor.values()].sort((x, y) =>
    y.provenEvidence - x.provenEvidence || y.pages - x.pages || (x.author < y.author ? -1 : 1));
}
