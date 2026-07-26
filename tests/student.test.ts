import { describe, it, expect } from 'vitest';
import { applyEvidence, effectiveLevel, isKnown } from '../src/student/model.js';
import type { PageMastery, StudentState } from '../src/types.js';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const m = (level: PageMastery['level'], last: string): PageMastery => ({
  level, evidence: [], misconceptions: [], last_reinforced: last,
});

describe('effectiveLevel (decay)', () => {
  it('handles unseen and fresh levels', () => {
    expect(effectiveLevel(undefined, d('2026-07-10'))).toBe('unseen');
    expect(effectiveLevel(m('mastered', '2026-07-01'), d('2026-07-10'))).toBe('mastered');
  });
  it('decays mastered after 45 days and practicing after 21', () => {
    expect(effectiveLevel(m('mastered', '2026-05-01'), d('2026-07-10'))).toBe('practicing');
    expect(effectiveLevel(m('practicing', '2026-06-01'), d('2026-07-10'))).toBe('exposed');
    expect(effectiveLevel(m('exposed', '2020-01-01'), d('2026-07-10'))).toBe('exposed');
  });
});

describe('applyEvidence', () => {
  it('bumps one level on correct explanation, from the EFFECTIVE level', () => {
    const state: StudentState = { bp: m('exposed', '2026-07-09') };
    const next = applyEvidence(state, 'bp', 'explained-correctly', 'derived it', d('2026-07-10'));
    expect(next.bp.level).toBe('practicing');
    expect(next.bp.last_reinforced).toBe('2026-07-10');
    expect(next.bp.evidence).toHaveLength(1);
    expect(state.bp.evidence).toHaveLength(0); // no mutation
    expect(next.bp.misconceptions).not.toBe(state.bp.misconceptions); // not shared by reference
  });

  // The "from the EFFECTIVE level" half of the case above, kept as its own test now that the two
  // kinds have different ceilings: a stored 'mastered' that has decayed to 'practicing' is bumped
  // from practicing, not from mastered.
  it('bumps from the effective level, not the stored one', () => {
    const state: StudentState = { bp: m('mastered', '2026-05-01') }; // effective: practicing
    const next = applyEvidence(state, 'bp', 'applied-correctly', 'did it', d('2026-07-10'));
    expect(next.bp.level).toBe('mastered'); // practicing + 1
  });

  // THE CEILING. Explaining is evidence of understanding, not of application, and 'mastered' is the
  // one claim here a learner would repeat to someone else — so it is reachable only through work a
  // machine checked. The harness enforces the other half (grading.ts's capApplied: model-graded
  // work cannot emit 'applied-correctly' at all), so together they mean 'mastered' requires a real
  // test suite, numeric equivalence, or an exact expected value.
  describe("only applied work reaches 'mastered'", () => {
    it('explaining repeatedly plateaus at practicing', () => {
      let state: StudentState = {};
      for (let i = 0; i < 5; i++) {
        state = applyEvidence(state, 'bp', 'explained-correctly', `round ${i}`, d('2026-07-10'));
      }
      expect(state.bp.level).toBe('practicing');
      // Five entries recorded — the plateau is a ceiling on the LEVEL, not a refusal to log the work.
      expect(state.bp.evidence).toHaveLength(5);
    });

    it('one applied pass on top of that plateau reaches mastered', () => {
      let state = applyEvidence({}, 'bp', 'explained-correctly', 'said it', d('2026-07-10'));
      state = applyEvidence(state, 'bp', 'explained-correctly', 'said it again', d('2026-07-10'));
      expect(state.bp.level).toBe('practicing');
      state = applyEvidence(state, 'bp', 'applied-correctly', 'did it', d('2026-07-10'));
      expect(state.bp.level).toBe('mastered');
    });

    it('does not push anyone DOWN — an explanation while mastered leaves mastered alone', () => {
      // The ceiling is a cap on the bump, not a demotion. A learner who earned 'mastered' by doing
      // the work and then explains it must not be knocked back for having talked about it.
      const state: StudentState = { bp: m('mastered', '2026-07-09') }; // still effectively mastered
      const next = applyEvidence(state, 'bp', 'explained-correctly', 'talked it through', d('2026-07-10'));
      expect(next.bp.level).toBe('mastered');
    });

    it('leaves progression alone: practicing still counts as known', () => {
      const state = applyEvidence({}, 'bp', 'explained-correctly', 'said it', d('2026-07-10'));
      const bumped = applyEvidence(state, 'bp', 'explained-correctly', 'again', d('2026-07-10'));
      // isKnown() gates prereqs, frontier and path progress. The ceiling must not lock a learner
      // out of their own syllabus for studying a subject with no applied exercise available.
      expect(isKnown(effectiveLevel(bumped.bp, d('2026-07-10')))).toBe(true);
    });

    it('the plateau decays on the practicing clock, which is the visible consequence', () => {
      const state = applyEvidence({}, 'bp', 'explained-correctly', 'said it', d('2026-07-10'));
      const capped = applyEvidence(state, 'bp', 'explained-correctly', 'again', d('2026-07-10'));
      // 21 days for practicing vs 45 for mastered: a page held up by explanation alone returns to
      // the review queue roughly twice as often as one backed by an exercise.
      expect(effectiveLevel(capped.bp, d('2026-07-25'))).toBe('practicing'); // 15 days: still holds
      expect(effectiveLevel(capped.bp, d('2026-08-05'))).toBe('exposed');    // 26 days: decayed
    });
  });
  it('creates entries for new pages and floors struggled at exposed', () => {
    const next = applyEvidence({}, 'bp', 'struggled', 'lost', d('2026-07-10'));
    expect(next.bp.level).toBe('exposed');
  });
  it('records misconceptions without level change', () => {
    const next = applyEvidence(
      { bp: m('practicing', '2026-07-01') }, 'bp', 'misconception', 'gradients', d('2026-07-10'),
      'thinks gradients flow forward'
    );
    expect(next.bp.level).toBe('practicing');
    expect(next.bp.misconceptions).toEqual(['thinks gradients flow forward']);
  });
  it('exposed never downgrades', () => {
    const next = applyEvidence({ bp: m('mastered', '2026-07-01') }, 'bp', 'exposed', 're-read', d('2026-07-10'));
    expect(next.bp.level).toBe('mastered');
  });
  it('exposure does NOT resurrect decayed mastery — decay materializes at effective level', () => {
    const next = applyEvidence({ bp: m('mastered', '2026-05-01') }, 'bp', 'exposed', 're-read', d('2026-07-10'));
    expect(next.bp.level).toBe('practicing'); // effective was practicing (decayed); exposure keeps it there
  });
  it('misconception evidence does NOT resurrect decayed mastery — decay materializes at effective level', () => {
    const next = applyEvidence(
      { bp: m('mastered', '2026-05-01') }, 'bp', 'misconception', 'still confused', d('2026-07-10'),
      'thinks gradients flow forward'
    );
    expect(next.bp.level).toBe('practicing'); // effective was practicing (decayed); misconception keeps it there, not mastered
  });
});

describe('isKnown', () => {
  it('is true for practicing and mastered only', () => {
    expect(isKnown('practicing')).toBe(true);
    expect(isKnown('mastered')).toBe(true);
    expect(isKnown('exposed')).toBe(false);
    expect(isKnown('unseen')).toBe(false);
  });
});

describe('rubric-passed — the third positive kind, never laundered upward', () => {
  const day = (d: string) => new Date(`${d}T12:00:00Z`);

  it('steps one rung and caps at practicing, like explanation', () => {
    let s = applyEvidence({}, 'essays', 'rubric-passed', 'thesis rubric', day('2026-07-01'));
    expect(s.essays.level).toBe('exposed');
    s = applyEvidence(s, 'essays', 'rubric-passed', 'again', day('2026-07-02'));
    expect(s.essays.level).toBe('practicing');
    s = applyEvidence(s, 'essays', 'rubric-passed', 'and again', day('2026-07-03'));
    // However many rubric passes accumulate, mastered stays a machine's word.
    expect(s.essays.level).toBe('practicing');
  });

  it('does not push a mastered learner DOWN — same outer-max property as explaining', () => {
    let s = {};
    for (const d of ['01', '02', '03']) s = applyEvidence(s, 'p', 'applied-correctly', 'suite', day(`2026-07-${d}`));
    expect((s as any).p.level).toBe('mastered');
    s = applyEvidence(s, 'p', 'rubric-passed', 'rubric later', day('2026-07-04'));
    expect((s as any).p.level).toBe('mastered');
  });

  it('decays on its own shorter window when the standing rests on a rubric', () => {
    let rubricHeld = {};
    for (const d of ['01', '02']) rubricHeld = applyEvidence(rubricHeld, 'p', 'rubric-passed', 'r', day(`2026-07-${d}`));
    let explainHeld = {};
    for (const d of ['01', '02']) explainHeld = applyEvidence(explainHeld, 'p', 'explained-correctly', 'e', day(`2026-07-${d}`));
    // Both sit at practicing on July 2. Fifteen days later only the rubric-held one has rotted:
    // 15 > rubricDays (14) but 15 < practicingDays (21).
    const later = day('2026-07-17');
    expect(effectiveLevel((rubricHeld as any).p, later)).toBe('exposed');
    expect(effectiveLevel((explainHeld as any).p, later)).toBe('practicing');
  });

  it('a later explanation moves the page back onto the ordinary window', () => {
    let s = {};
    for (const d of ['01', '02']) s = applyEvidence(s, 'p', 'rubric-passed', 'r', day(`2026-07-${d}`));
    s = applyEvidence(s, 'p', 'explained-correctly', 'now explained too', day('2026-07-03'));
    // Most recent level-raising evidence is the explanation, so 18 stale days survive.
    expect(effectiveLevel((s as any).p, day('2026-07-21'))).toBe('practicing');
  });
});
