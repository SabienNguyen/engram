import { describe, it, expect } from 'vitest';
import { LEVELS, DECAY } from '../src/types.js';

describe('core types', () => {
  it('orders mastery levels', () => {
    expect(LEVELS).toEqual(['unseen', 'exposed', 'practicing', 'mastered']);
  });
  it('exposes decay defaults from the spec', () => {
    expect(DECAY).toEqual({ masteredDays: 45, practicingDays: 21 });
  });
});
