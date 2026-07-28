import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from '../src/vault/vaultStore.js';

let root: string;
let store: VaultStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lw-'));
  mkdirSync(join(root, 'pages', 'ml'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'ml', 'chain-rule.md'),
    '---\ntitle: Chain Rule\nstatus: solid\n---\nd/dx of composition.'
  );
  store = new VaultStore(root);
});

describe('VaultStore', () => {
  it('loads pages recursively with domain', () => {
    const pages = store.loadPages();
    expect(pages.get('chain-rule')?.domain).toBe('ml');
    expect(pages.get('chain-rule')?.meta.title).toBe('Chain Rule');
  });

  it('writes and re-reads a page', () => {
    const p = store.loadPages().get('chain-rule')!;
    store.writePage('chain-rule', { ...p.meta, difficulty: 2 }, p.body);
    expect(store.loadPages().get('chain-rule')?.meta.difficulty).toBe(2);
    // stayed in its original file
    expect(readFileSync(join(root, 'pages', 'ml', 'chain-rule.md'), 'utf8')).toContain('difficulty: 2');
  });

  it('creates stubs idempotently', () => {
    store.createStub('jacobians');
    store.createStub('jacobians');
    const p = store.loadPages().get('jacobians')!;
    expect(p.meta.status).toBe('stub');
  });

  it('round-trips student state and defaults to {}', () => {
    expect(store.readStudent('sabien')).toEqual({});
    store.writeStudent('sabien', {
      'chain-rule': { level: 'exposed', evidence: [], misconceptions: [], last_reinforced: '2026-07-10' },
    });
    expect(store.readStudent('sabien')['chain-rule'].level).toBe('exposed');
  });

  it('refuses a student name that would escape the students directory', () => {
    // record_evidence/get_student_state take `student` as a free string straight from an MCP
    // argument; a traversal name must not read or write outside the vault, the same containment
    // the slug-valued paths get for free from slugify.
    expect(() => store.readStudent('../secret')).toThrow(/escape/);
    expect(() => store.writeStudent('../../evil', {})).toThrow(/escape/);
    expect(() => store.readRaw('../students/sabien.json')).toThrow(/escape/);
    // an ordinary id, including one with dots/underscores, is untouched.
    store.writeStudent('john.doe_2', {
      'chain-rule': { level: 'exposed', evidence: [], misconceptions: [], last_reinforced: '2026-07-10' },
    });
    expect(store.readStudent('john.doe_2')['chain-rule'].level).toBe('exposed');
  });

  it('prepends review log entries and stores rationales', () => {
    store.appendReviewLog('- 2026-07-10 [prereq] a -> b — because');
    store.appendReviewLog('- 2026-07-11 [related] c -> d — reason2');
    const log = readFileSync(join(root, 'review-log.md'), 'utf8');
    expect(log.indexOf('c -> d')).toBeLessThan(log.indexOf('a -> b'));
    store.saveRationale('a->b:prereq', 'because');
    expect(store.readRationales()['a->b:prereq']).toBe('because');
  });

  it('handles path docs and raw files', () => {
    mkdirSync(join(root, 'raw'), { recursive: true });
    writeFileSync(join(root, 'raw', 'notes.md'), 'raw stuff');
    expect(store.listRaw()).toEqual(['notes.md']);
    expect(store.readRaw('notes.md')).toBe('raw stuff');
    store.writePathDoc('calc-basics', 'Calculus Basics', ['chain-rule'], 'Start here.');
    expect(store.listPathDocs()).toEqual([{ slug: 'calc-basics', title: 'Calculus Basics', pages: ['chain-rule'] }]);
    expect(store.readPathDoc('calc-basics')?.body).toContain('Start here.');
  });

  it('fails loud with a clear error on corrupt student JSON', () => {
    mkdirSync(join(root, 'students'), { recursive: true });
    writeFileSync(join(root, 'students', 'bad.json'), '{not json');
    expect(() => store.readStudent('bad')).toThrow(/student file corrupt/);
  });

  it('self-heals corrupt rationales cache', () => {
    mkdirSync(join(root, '.index'), { recursive: true });
    writeFileSync(join(root, '.index', 'rationales.json'), '{not json');
    expect(store.readRationales()).toEqual({});
  });

  it('readRaw throws a clear error for missing files', () => {
    expect(() => store.readRaw('ghost.md')).toThrow(/raw file not found/);
  });
});
