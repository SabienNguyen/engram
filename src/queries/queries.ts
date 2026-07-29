import { daysOverdue, effectiveLevel, isKnown } from '../student/model.js';
import type { EmbeddingIndex } from '../embeddings/index.js';
import type { LessonSuggestion, Page, StudentState } from '../types.js';

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
