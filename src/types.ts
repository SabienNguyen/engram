export type LinkType = 'prereq' | 'deepens' | 'related';
export type PageStatus = 'stub' | 'draft' | 'solid';

export interface PageMeta {
  title: string;
  prereqs: string[]; // page slugs
  deepens: string[];
  tags: string[];
  difficulty: number; // 1-5
  status: PageStatus;
  sources: string[];
}

export interface Page {
  slug: string; // unique kebab-case basename, no extension
  domain: string; // folder under pages/, '' if flat
  meta: PageMeta;
  body: string; // markdown body without frontmatter
  inlineLinks: string[]; // [[wiki-link]] targets as slugs (deduped)
  warnings: string[]; // parse problems; non-empty forces status 'draft'
}

export interface Edge {
  src: string;
  dst: string;
  type: LinkType;
}

export type MasteryLevel = 'unseen' | 'exposed' | 'practicing' | 'mastered';
export const LEVELS: MasteryLevel[] = ['unseen', 'exposed', 'practicing', 'mastered'];

// rubricDays is the shortest window of the three on purpose: a rubric verdict is a model applying
// stated criteria — the least verified of the positive evidence kinds — so standing that rests on
// one is re-checked soonest. These are the BASE windows; per-item stability (STABILITY below)
// stretches them for a page a learner has re-confirmed, spaced out, several times.
export const DECAY = { masteredDays: 45, practicingDays: 21, rubricDays: 14 };

// Per-item memory strength, FSRS-style. The science the base windows ignore: successfully recalling
// something AFTER A GAP — long enough that you were at some real risk of having lost it — is what
// actually consolidates a memory; two reviews crammed into one afternoon barely move it. So each
// SPACED successful reinforcement multiplies a page's decay window by `growth` (up to `maxFactor`),
// while a crammed repeat (closer together than `minSpacingFraction` of the base window) is logged
// but earns no extra time, and any lapse drops the page straight back to its base window. This is
// the same anti-inflation stance the rest of the model takes — trust the learner has not re-earned
// is never granted — now expressed as WHEN a page comes back rather than only what level it holds.
// Derived entirely from the evidence log; no stored field, so it is backward-compatible with every
// vault written before it existed (a page with one success or none simply sits at factor 1).
//
//   factor = min(growth ** (spacedSuccesses - 1), maxFactor)
//
// With growth 1.6 and maxFactor 4: a page confirmed once rides its base window; a second, third,
// fourth spaced confirmation take it to ~1.6x, ~2.6x, then the 4x ceiling — a mastered page can
// stretch from 45 days out toward ~180 before it wants review, exactly where a well-drilled memory
// should sit, while a page that just crossed the line still returns on the base clock.
export const STABILITY = { growth: 1.6, maxFactor: 4, minSpacingFraction: 0.4 };

export type EvidenceKind =
  | 'exposed'
  | 'explained-correctly'
  | 'applied-correctly'
  // A model judged produced WORK against an explicit rubric — history essays, legal analysis,
  // literature. Deliberately its own kind rather than borrowing 'explained-correctly': subjects
  // with no mechanical check either get this or stay second-class forever, and keeping it named
  // means it can never launder itself into the applied evidence that gates 'mastered'.
  | 'rubric-passed'
  | 'struggled'
  | 'misconception';

export interface Evidence {
  date: string; // ISO yyyy-mm-dd
  kind: EvidenceKind;
  note: string;
  /** When this entry's `resolves` cleared a recorded misconception: the cleared text, verbatim.
   *  The misconceptions array forgets what was repaired (correctly — it lists ACTIVE confusions);
   *  the evidence log is where the repair becomes part of the learner's visible history. */
  resolved?: string;
}

export interface PageMastery {
  level: MasteryLevel;
  evidence: Evidence[];
  misconceptions: string[];
  last_reinforced: string; // ISO yyyy-mm-dd
}

export type StudentState = Record<string, PageMastery>;

export interface LinkCandidate {
  src: string;
  dst: string;
  score: number; // 0..1
  via: 'semantic' | 'lexical';
}

export interface WorkingSetMember {
  slug: string;
  title: string;
  level: MasteryLevel; // stored
  effective: MasteryLevel; // decay-adjusted, at the time of the call
  lastEvidence: string | null; // ISO yyyy-mm-dd of the freshest evidence; null for a pulled-in neighbor with none
  due: boolean; // effective !== level, i.e. the standing has decayed
  why: 'recent-evidence' | `neighbor:${string}`; // neighbor tag names the seed that pulled it in
  misconceptions?: number; // present only when > 0
}

export interface LessonSuggestion {
  slug: string;
  title: string;
  reason: 'review-due' | 'unmet-prereq' | 'frontier';
  detail: string;
}
