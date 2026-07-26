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
// one is re-checked soonest.
export const DECAY = { masteredDays: 45, practicingDays: 21, rubricDays: 14 };

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

export interface LessonSuggestion {
  slug: string;
  title: string;
  reason: 'review-due' | 'unmet-prereq' | 'frontier';
  detail: string;
}
