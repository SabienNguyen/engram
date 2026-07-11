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
    const state: StudentState = { bp: m('mastered', '2026-05-01') }; // effective: practicing
    const next = applyEvidence(state, 'bp', 'explained-correctly', 'derived it', d('2026-07-10'));
    expect(next.bp.level).toBe('mastered');
    expect(next.bp.last_reinforced).toBe('2026-07-10');
    expect(next.bp.evidence).toHaveLength(1);
    expect(state.bp.evidence).toHaveLength(0); // no mutation
    expect(next.bp.misconceptions).not.toBe(state.bp.misconceptions); // not shared by reference
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
