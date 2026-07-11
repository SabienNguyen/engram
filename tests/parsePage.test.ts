import { describe, it, expect } from 'vitest';
import { parsePage, serializePage, slugify } from '../src/vault/parsePage.js';

const GOOD = `---
title: Backpropagation
prereqs: [chain-rule, gradient-descent]
deepens: [jacobians]
tags: [deep-learning]
difficulty: 3
status: solid
sources: [raw/cs231n.md]
---
# Backpropagation
Works like [[Dynamic Programming]] reuse. See [[chain-rule]] too.
And [[chain-rule]] again (dedupe me).
`;

describe('parsePage', () => {
  it('parses frontmatter and inline wiki-links', () => {
    const p = parsePage('backpropagation', 'ml', GOOD);
    expect(p.meta.title).toBe('Backpropagation');
    expect(p.meta.prereqs).toEqual(['chain-rule', 'gradient-descent']);
    expect(p.meta.deepens).toEqual(['jacobians']);
    expect(p.meta.status).toBe('solid');
    expect(p.inlineLinks).toEqual(['dynamic-programming', 'chain-rule']);
    expect(p.warnings).toEqual([]);
  });

  it('never crashes on malformed frontmatter; forces draft with warning', () => {
    const p = parsePage('bad', '', '---\nprereqs: not-an-array\nstatus: solid\n---\nbody');
    expect(p.meta.status).toBe('draft');
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.meta.prereqs).toEqual([]);
    expect(p.body).toContain('body');
  });

  it('defaults missing fields', () => {
    const p = parsePage('plain', '', 'no frontmatter at all');
    expect(p.meta.title).toBe('plain');
    expect(p.meta.difficulty).toBe(3);
    expect(p.meta.status).toBe('draft');
  });

  it('slugifies', () => {
    expect(slugify('  Chain Rule ')).toBe('chain-rule');
  });

  it('round-trips through serializePage', () => {
    const p = parsePage('backpropagation', 'ml', GOOD);
    const again = parsePage('backpropagation', 'ml', serializePage(p.meta, p.body));
    expect(again.meta).toEqual(p.meta);
    expect(again.inlineLinks).toEqual(p.inlineLinks);
  });
});
