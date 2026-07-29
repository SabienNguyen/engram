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

/** Does this page's current standing rest on a rubric verdict? True when the most recent
 *  level-raising evidence is 'rubric-passed' — i.e. nothing mechanical or explanatory has
 *  reconfirmed the page since a model's rubric judgment last held it up. */
function restsOnRubric(m: PageMastery): boolean {
  for (let i = m.evidence.length - 1; i >= 0; i--) {
    const k = m.evidence[i].kind;
    if (k === 'applied-correctly' || k === 'explained-correctly') return false;
    if (k === 'rubric-passed') return true;
  }
  return false;
}

export function effectiveLevel(m: PageMastery | undefined, now: Date): MasteryLevel {
  if (!m) return 'unseen';
  const staleDays = (now.getTime() - new Date(m.last_reinforced + 'T00:00:00Z').getTime()) / DAY_MS;
  if (m.level === 'mastered' && staleDays > DECAY.masteredDays) return 'practicing';
  if (m.level === 'practicing') {
    // Rubric-held standing decays on its own, shorter window — the visible consequence of the
    // evidence being a model's judgment of criteria rather than a machine's confirmation.
    const window = restsOnRubric(m) ? DECAY.rubricDays : DECAY.practicingDays;
    if (staleDays > window) return 'exposed';
  }
  return m.level;
}

export function isKnown(level: MasteryLevel): boolean {
  return level === 'practicing' || level === 'mastered';
}

/**
 * Days until this page's standing decays a rung, using the SAME windows and the SAME rubric walk
 * effectiveLevel applies — the memory layer reporting its own expiry, so no consumer re-derives
 * the window and silently promises 21 days to a page that rots in 14.
 *
 * null when nothing is decaying: unseen/exposed pages have no standing to lose, and a page that
 * has ALREADY slipped (level > effective) has no countdown left — `slipped` is the caller's
 * signal there, computable from the two levels it already has.
 */
export function decayDaysLeft(m: PageMastery | undefined, now: Date): number | null {
  if (!m) return null;
  const staleDays = (now.getTime() - new Date(m.last_reinforced + 'T00:00:00Z').getTime()) / DAY_MS;
  const window = m.level === 'mastered' ? DECAY.masteredDays
    : m.level === 'practicing' ? (restsOnRubric(m) ? DECAY.rubricDays : DECAY.practicingDays)
      : null;
  if (window === null) return null;
  const left = Math.ceil(window - staleDays);
  return left > 0 ? left : null;
}

/**
 * How many days a page has sat PAST its decay window — the review-queue urgency signal. Uses the
 * same window and rubric walk as effectiveLevel/decayDaysLeft, so a page held up by explanation
 * (14/21-day window) reads as more overdue than a mastered page (45) at the same staleness, which
 * is exactly the priority the queue should reflect. Negative or ~0 for a page that has not slipped
 * yet (those aren't in the queue); 0 for unseen/exposed, which have no window.
 */
export function daysOverdue(m: PageMastery | undefined, now: Date): number {
  if (!m) return 0;
  const staleDays = (now.getTime() - new Date(m.last_reinforced + 'T00:00:00Z').getTime()) / DAY_MS;
  const window = m.level === 'mastered' ? DECAY.masteredDays
    : m.level === 'practicing' ? (restsOnRubric(m) ? DECAY.rubricDays : DECAY.practicingDays)
      : 0;
  return staleDays - window;
}

export function applyEvidence(
  state: StudentState,
  slug: string,
  kind: EvidenceKind,
  note: string,
  now: Date,
  misconception?: string,
  resolves?: string
): StudentState {
  const today = now.toISOString().slice(0, 10);
  const prev: PageMastery = state[slug] ?? {
    level: 'unseen', evidence: [], misconceptions: [], last_reinforced: today,
  };
  // Resolving a misconception: the learner DEMONSTRATED the confusion no longer holds, and the
  // tutor names which one. Matched by substring (case-insensitive) because the tutor is quoting a
  // note it may not have verbatim; removing only the first match keeps a second, similar
  // misconception alive rather than clearing both on one demonstration. Without this, a recorded
  // misconception outlives its own repair and returns in every future session plan.
  let misconceptions = [...prev.misconceptions];
  let resolvedText: string | undefined;
  if (resolves) {
    const needle = resolves.trim().toLowerCase();
    const i = misconceptions.findIndex((m) => m.toLowerCase().includes(needle) || needle.includes(m.toLowerCase()));
    if (i >= 0) [resolvedText] = misconceptions.splice(i, 1);
  }
  if (misconception) misconceptions = [...misconceptions, misconception];
  const from = effectiveLevel(state[slug], now);

  let level: MasteryLevel = from;
  if (kind === 'exposed') level = LEVELS[Math.max(idx(from), idx('exposed'))];
  else if (kind === 'explained-correctly' || kind === 'applied-correctly' || kind === 'rubric-passed') {
    // Both step exactly one rung — anti-inflation, unchanged.
    //
    // The CEILING is the new part: explaining alone stops at 'practicing'. 'mastered' is the only
    // claim this model makes that a learner would quote to someone else, and it should mean a
    // machine confirmed the work, not that a model was satisfied by a description of it. The
    // harness enforces the other half of the same rule (src/server/grading.ts's capApplied: only
    // mechanically-verified grading may emit 'applied-correctly' at all), so the two together mean
    // 'mastered' is reachable only through a real test suite, numeric equivalence, or an exact
    // expected value.
    //
    // Deliberately NOT a change to progression. isKnown() is true at 'practicing', so prereq
    // gating, frontier selection, nextLessons and path progress all behave exactly as before — a
    // learner can still work through an entire syllabus on explanation alone. What changes is that
    // the top of the scale is no longer available for it.
    //
    // The visible consequence, which is the point: 'practicing' decays after
    // DECAY.practicingDays (21) rather than DECAY.masteredDays (45), so a page held up by
    // explanation alone returns to the review queue about twice as often as one backed by an
    // exercise. That is the signal — you can describe this, you have never done it — and it costs
    // no new machinery.
    //
    // Known limitation, accepted rather than hidden: subjects with no applied block available
    // (nothing mechanical can currently check history, law, or literature) can never reach
    // 'mastered'. The honest fix is to say so in the UI, not to quietly exempt them — a per-subject
    // exemption registry would be the same hand-authoring bottleneck it is meant to relieve.
    // The ceiling caps the BUMP; it must never pull anyone down. Without the outer max(), a learner
    // who reached 'mastered' by doing the work and then explained it was demoted to 'practicing' —
    // punished for having talked about something they had already proved. (Caught by the
    // "does not push anyone DOWN" case in tests/student.test.ts, which failed against the obvious
    // one-line version of this.)
    // 'rubric-passed' shares the explanation ceiling: a rubric is a model judging produced work,
    // which is MORE than explaining and still not a machine's confirmation — so it advances a
    // learner the same one rung, stops at 'practicing', and (see effectiveLevel) decays faster.
    const ceiling = kind === 'applied-correctly' ? idx('mastered') : idx('practicing');
    level = LEVELS[Math.max(idx(from), Math.min(idx(from) + 1, ceiling))];
  } else if (kind === 'struggled') level = LEVELS[Math.max(idx(from) - 1, idx('exposed'))];
  // 'misconception': level unchanged

  // last_reinforced is the date the CURRENT standing was established, and it drives decay. A kind
  // that RE-CONFIRMS the standing restarts it — the demonstrative kinds (applied/explained/rubric,
  // and 'struggled' whose demoted level starts its clock at the demotion) do, even when the level
  // is capped or unchanged, because the learner did gradable work. Two kinds do NOT re-confirm and
  // so keep the existing clock:
  //   - 'misconception' changes no level and demonstrates the OPPOSITE of standing — resetting the
  //     clock for it meant recording a learner's confusion extended the system's trust in their
  //     mastery by a whole fresh decay window (caught by a live session-plan audit: a practicing
  //     page a day from review would have earned 21 more days of credit from a misconception note).
  //   - a bare 'exposed' that does NOT raise the level (the page was already ≥ exposed) is an
  //     ENCOUNTER, not a confirmation: a re-read, a partial pronounce, watched-only code rungs. It
  //     changes no standing, so — by the very same principle above — it must not refresh the decay
  //     window and hand a mastered page 45 more days the learner never re-earned. (Only unseen ->
  //     exposed raises the level, and 'exposed' has no decay clock of its own anyway, so this bites
  //     exactly the practicing/mastered case where it should.)
  const reconfirmsStanding = !(kind === 'misconception' || (kind === 'exposed' && idx(level) === idx(from)));
  const reinforced = reconfirmsStanding ? today : prev.last_reinforced;

  return {
    ...state,
    [slug]: {
      level,
      evidence: [...prev.evidence, { date: today, kind, note, ...(resolvedText ? { resolved: resolvedText } : {}) }],
      misconceptions,
      last_reinforced: reinforced,
    },
  };
}
