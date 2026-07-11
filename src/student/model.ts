import {
  DECAY, LEVELS,
} from '../types.js';
import type {
  EvidenceKind, MasteryLevel, PageMastery, StudentState,
} from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function idx(l: MasteryLevel): number {
  return LEVELS.indexOf(l);
}

export function effectiveLevel(m: PageMastery | undefined, now: Date): MasteryLevel {
  if (!m) return 'unseen';
  const staleDays = (now.getTime() - new Date(m.last_reinforced + 'T00:00:00Z').getTime()) / DAY_MS;
  if (m.level === 'mastered' && staleDays > DECAY.masteredDays) return 'practicing';
  if (m.level === 'practicing' && staleDays > DECAY.practicingDays) return 'exposed';
  return m.level;
}

export function isKnown(level: MasteryLevel): boolean {
  return level === 'practicing' || level === 'mastered';
}

export function applyEvidence(
  state: StudentState,
  slug: string,
  kind: EvidenceKind,
  note: string,
  now: Date,
  misconception?: string
): StudentState {
  const today = now.toISOString().slice(0, 10);
  const prev: PageMastery = state[slug] ?? {
    level: 'unseen', evidence: [], misconceptions: [], last_reinforced: today,
  };
  const from = effectiveLevel(state[slug], now);

  let level: MasteryLevel = prev.level;
  if (kind === 'exposed') level = LEVELS[Math.max(idx(from), idx('exposed'))];
  else if (kind === 'explained-correctly' || kind === 'applied-correctly')
    level = LEVELS[Math.min(idx(from) + 1, idx('mastered'))];
  else if (kind === 'struggled') level = LEVELS[Math.max(idx(from) - 1, idx('exposed'))];
  // 'misconception': level unchanged

  return {
    ...state,
    [slug]: {
      level,
      evidence: [...prev.evidence, { date: today, kind, note }],
      misconceptions: misconception ? [...prev.misconceptions, misconception] : [...prev.misconceptions],
      last_reinforced: today,
    },
  };
}
