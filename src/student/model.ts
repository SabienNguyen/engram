import {
  DECAY, LEVELS, STABILITY,
} from '../types.js';
import type {
  EvidenceKind, MasteryLevel, PageMastery, StudentState,
} from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function idx(l: MasteryLevel): number {
  return LEVELS.indexOf(l);
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso + 'T00:00:00Z').getTime()) / DAY_MS;
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

/** The BASE decay window for a page's stored level, before per-item stability. mastered gets the
 *  long window; practicing splits on whether it rests on a rubric verdict (shorter). unseen/exposed
 *  have no standing to lose, so null. The single place the level→window mapping lives; everything
 *  else derives from here so the three exported functions can never drift apart. */
function baseWindow(m: PageMastery): number | null {
  if (m.level === 'mastered') return DECAY.masteredDays;
  if (m.level === 'practicing') return restsOnRubric(m) ? DECAY.rubricDays : DECAY.practicingDays;
  return null;
}

/** FSRS-style memory strength as a multiplier on the base window. Walks the evidence oldest→newest
 *  counting SPACED successful reinforcements: a success (applied/explained/rubric) grows the streak
 *  only when it landed at least `minSpacingFraction` of the base window after the previous
 *  reinforcement — recalling after a real gap is what consolidates memory, so same-day cramming is
 *  logged but earns no extra window. A lapse (a 'struggled' demotion or a fresh 'misconception')
 *  resets the streak to zero: stability the learner has stopped demonstrating is not kept on the
 *  books. A bare 'exposed' encounter is neutral — neither a success nor a lapse nor an anchor.
 *  Returns 1 (base window) for a page with zero or one spaced success; grows by `growth` per spaced
 *  success beyond the first, capped at `maxFactor`. */
function stabilityFactor(m: PageMastery): number {
  const base = baseWindow(m);
  if (base === null) return 1;
  const minGap = STABILITY.minSpacingFraction * base;
  let streak = 0;
  let lastAnchorMs: number | null = null; // last reinforcement we measure spacing from
  for (const e of m.evidence) {
    const t = new Date(e.date + 'T00:00:00Z').getTime();
    if (e.kind === 'applied-correctly' || e.kind === 'explained-correctly' || e.kind === 'rubric-passed') {
      const gap = lastAnchorMs === null ? Infinity : (t - lastAnchorMs) / DAY_MS;
      if (gap >= minGap) streak++; // a spaced recall strengthens; a crammed repeat does not
      lastAnchorMs = t; // either way it is the new reference point for the NEXT one
    } else if (e.kind === 'struggled' || e.kind === 'misconception') {
      streak = 0; // a lapse wipes accumulated stability back to the base window
      if (e.kind === 'struggled') lastAnchorMs = t; // struggled re-anchors (it restarts the clock);
      // a misconception does not re-anchor — it changes no standing and keeps the existing clock.
    }
    // 'exposed': neutral, skipped entirely.
  }
  return Math.min(STABILITY.growth ** Math.max(0, streak - 1), STABILITY.maxFactor);
}

/** This page's ACTUAL decay window: its base window stretched by per-item stability. The one helper
 *  effectiveLevel/decayDaysLeft/daysOverdue all read, so a well-reinforced page and a barely-reached
 *  one are treated consistently everywhere. null when there is no standing to decay. */
function stabilityWindow(m: PageMastery): number | null {
  const base = baseWindow(m);
  return base === null ? null : base * stabilityFactor(m);
}

export function effectiveLevel(m: PageMastery | undefined, now: Date): MasteryLevel {
  if (!m) return 'unseen';
  const window = stabilityWindow(m);
  if (window === null || daysSince(m.last_reinforced, now) <= window) return m.level;
  // One rung down: mastered→practicing, practicing→exposed (the same single-step decay as before,
  // now on the stability-adjusted window). exposed/unseen returned null above, so this is exhaustive.
  return m.level === 'mastered' ? 'practicing' : 'exposed';
}

export function isKnown(level: MasteryLevel): boolean {
  return level === 'practicing' || level === 'mastered';
}

/**
 * Days until this page's standing decays a rung, using the SAME stability-adjusted window
 * effectiveLevel applies — the memory layer reporting its own expiry, so no consumer re-derives
 * the window and silently promises 21 days to a page that rots in 14 (or 33 to one a learner has
 * re-earned).
 *
 * null when nothing is decaying: unseen/exposed pages have no standing to lose, and a page that
 * has ALREADY slipped (level > effective) has no countdown left — `slipped` is the caller's
 * signal there, computable from the two levels it already has.
 */
export function decayDaysLeft(m: PageMastery | undefined, now: Date): number | null {
  if (!m) return null;
  const window = stabilityWindow(m);
  if (window === null) return null;
  const left = Math.ceil(window - daysSince(m.last_reinforced, now));
  return left > 0 ? left : null;
}

/**
 * How many days a page has sat PAST its decay window — the review-queue urgency signal. Uses the
 * same stability-adjusted window as effectiveLevel/decayDaysLeft, so a page held up by explanation
 * (short window) reads as more overdue than a mastered page (long window) at the same staleness,
 * and a well-drilled page reads as LESS overdue than a barely-reached one — exactly the priority the
 * queue should reflect. Negative or ~0 for a page that has not slipped yet (those aren't in the
 * queue); 0 for unseen/exposed, which have no window.
 */
export function daysOverdue(m: PageMastery | undefined, now: Date): number {
  if (!m) return 0;
  return daysSince(m.last_reinforced, now) - (stabilityWindow(m) ?? 0);
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
  // Same matching the resolve path above uses, for the same reason: the tutor is quoting a
  // confusion it may not have verbatim, so "already recorded" cannot mean byte-equal. A learner
  // who voices one wrong belief across several sittings otherwise collects identical ⚠ entries —
  // seen live, four copies of one sentence — which the graph marker, the page panel and the
  // repair queue all read, scheduling the same repair again and again. The EVIDENCE log still
  // gets a row per voicing; only the standing list is deduped.
  if (misconception) {
    const needle = misconception.trim().toLowerCase();
    const already = misconceptions.some(
      (m) => m.toLowerCase().includes(needle) || needle.includes(m.toLowerCase()),
    );
    if (!already) misconceptions = [...misconceptions, misconception];
  }
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
