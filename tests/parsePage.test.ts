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

  it('ignores [[links]] shown as code — a wiki-syntax lesson mints no phantom edges', () => {
    // A page teaching wiki/Obsidian markup shows `[[example]]` as content; counting it created a
    // phantom 'related' edge and a "no page yet" mention to a page that never existed. The real
    // prose link still counts, and the body is returned untouched.
    const md = [
      '---\ntitle: Wiki Syntax\n---',
      'Type `[[note-name]]` to link, e.g.:',
      '```',
      'See [[in-a-fence]] here.',
      '```',
      'But [[real-target]] in prose is a genuine link.',
    ].join('\n');
    const p = parsePage('wiki-syntax', '', md);
    expect(p.inlineLinks).toEqual(['real-target']);
    expect(p.body).toContain('[[note-name]]'); // body verbatim
  });

  it('never crashes on malformed frontmatter; forces draft with warning', () => {
    const p = parsePage('bad', '', '---\nprereqs: not-an-array\nstatus: solid\n---\nbody');
    expect(p.meta.status).toBe('draft');
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.meta.prereqs).toEqual([]);
    expect(p.body).toContain('body');
  });

  it('strips frontmatter from body even when YAML is syntactically broken', () => {
    const p = parsePage('broken', '', '---\nprereqs: [unterminated\n---\nreal body here');
    expect(p.warnings.some((w) => w.includes('frontmatter parse error'))).toBe(true);
    expect(p.meta.status).toBe('draft');
    expect(p.body).toContain('real body here');
    expect(p.body).not.toContain('unterminated');
    expect(p.body).not.toContain('---');
  });

  it('warns and drops sources when malformed, downgrading status', () => {
    const p = parsePage(
      'bad-sources',
      '',
      '---\ntitle: X\nstatus: solid\nsources: 42\n---\nbody',
    );
    expect(p.meta.sources).toEqual([]);
    expect(p.warnings.some((w) => w.includes('sources'))).toBe(true);
    expect(p.meta.status).toBe('draft');
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

describe('parsePage — authors', () => {
  const withAuthors = (frontmatter: string) =>
    parsePage('p', '', `---\ntitle: T\n${frontmatter}\n---\nbody`);

  it('keeps author names verbatim — a person is not a slug', () => {
    const p = withAuthors('authors: ["Grant Sanderson", "Steven Strogatz"]');
    expect(p.meta.authors).toEqual(['Grant Sanderson', 'Steven Strogatz']);
    expect(p.warnings).toEqual([]);
  });

  it('reads a single unbracketed name as one author (the obvious hand-edit)', () => {
    const p = withAuthors('authors: Grant Sanderson');
    expect(p.meta.authors).toEqual(['Grant Sanderson']);
    expect(p.warnings).toEqual([]);
  });

  it('absent authors is an empty list, not a warning', () => {
    const p = parsePage('p', '', '---\ntitle: T\n---\nbody');
    expect(p.meta.authors).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it('a non-string-array authors warns and degrades to empty', () => {
    const p = withAuthors('authors: 42');
    expect(p.meta.authors).toEqual([]);
    expect(p.warnings).toContain('invalid authors: expected string array');
  });

  it('round-trips through serializePage', () => {
    const p = withAuthors('authors: ["Ada Lovelace"]');
    const again = parsePage('p', '', serializePage(p.meta, p.body));
    expect(again.meta.authors).toEqual(['Ada Lovelace']);
  });
});
