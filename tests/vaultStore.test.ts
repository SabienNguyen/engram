import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from '../src/vault/vaultStore.js';
import { effectiveLevel } from '../src/student/model.js';

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

  it('writes student state atomically — no temp litter, clean overwrite', () => {
    // The mastery file is the one irreplaceable thing the vault holds, so writeStudent goes through
    // a temp-then-rename: a torn write can never truncate it. Observable here: after a successful
    // write the target exists and no `.tmp` sibling is left behind, and a second write cleanly
    // renames over the existing file (the crash-mid-write case itself needs process death to prove).
    const f = join(root, 'students', 'sabien.json');
    store.writeStudent('sabien', {
      'chain-rule': { level: 'exposed', evidence: [], misconceptions: [], last_reinforced: '2026-07-10' },
    });
    expect(existsSync(f)).toBe(true);
    expect(existsSync(`${f}.tmp`)).toBe(false);
    store.writeStudent('sabien', {
      'chain-rule': { level: 'mastered', evidence: [], misconceptions: [], last_reinforced: '2026-07-20' },
    });
    expect(store.readStudent('sabien')['chain-rule'].level).toBe('mastered');
    expect(existsSync(`${f}.tmp`)).toBe(false);
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

describe('VaultStore — a page whose frontmatter we cannot read', () => {
  // A tab in the YAML is the classic Obsidian hand-edit. parsePage degrades to empty meta rather
  // than throwing (one bad page must not break every read of the vault), so the write path is the
  // only place that can stop that emptiness being written in as truth.
  const BROKEN =
    '---\ntitle: Chain Rule\nprereqs: [derivatives, limits]\nsources: [raw/spivak.md]\ndifficulty: 4\nstatus: solid\nbad:\t- tabbed\n---\nd/dx of composition.\n';
  const file = () => join(root, 'pages', 'ml', 'chain-rule.md');
  let errors: string[];

  beforeEach(() => {
    writeFileSync(file(), BROKEN);
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps every frontmatter field through a write instead of erasing it', () => {
    const p = store.loadPages().get('chain-rule')!;
    expect(p.meta.prereqs).toEqual([]); // the read really did lose them — that is the hazard
    store.writePage('chain-rule', p.meta, p.body, 'ml');
    const after = readFileSync(file(), 'utf8');
    expect(after).toContain('prereqs: [derivatives, limits]');
    expect(after).toContain('sources: [raw/spivak.md]');
    expect(after).toContain('status: solid');
    expect(after).not.toContain('prereqs: []');
  });

  it('round-trips the file byte-for-byte when the body is unchanged', () => {
    const p = store.loadPages().get('chain-rule')!;
    store.writePage('chain-rule', p.meta, p.body, 'ml');
    expect(readFileSync(file(), 'utf8')).toBe(BROKEN);
  });

  it('still writes the new body, and degrades loudly rather than silently', () => {
    const p = store.loadPages().get('chain-rule')!;
    const written = store.writePage('chain-rule', p.meta, 'rewritten body.\n', 'ml');
    expect(readFileSync(file(), 'utf8')).toContain('rewritten body.');
    // Two channels, both already used by this codebase: the page's own warnings (read_page and
    // write_page return them) and a console.error naming the file.
    expect(written.warnings.some((w) => w.includes('frontmatter parse error'))).toBe(true);
    expect(errors.join('\n')).toContain('chain-rule.md');
  });

  it('reads the same on the second load — the parse failure is not cached away', () => {
    // gray-matter caches its file object keyed by the whole input string and writes the entry
    // BEFORE parsing, so a throwing parse poisoned the cache: the second read of the same bytes
    // came back as a clean parse with no warning and the `---` delimiters served as body text.
    const first = store.loadPages().get('chain-rule')!;
    const second = store.loadPages().get('chain-rule')!;
    expect(second.warnings).toEqual(first.warnings);
    expect(second.body).not.toContain('---');
  });

  it('a page that parses is still managed normally', () => {
    // The preserve path must not swallow ordinary edits — only frontmatter we could not read.
    writeFileSync(file(), '---\ntitle: Chain Rule\nstatus: solid\n---\nbody\n');
    const p = store.loadPages().get('chain-rule')!;
    store.writePage('chain-rule', { ...p.meta, difficulty: 2 }, p.body, 'ml');
    expect(readFileSync(file(), 'utf8')).toContain('difficulty: 2');
    expect(errors).toEqual([]);
  });
});

describe('VaultStore — a student file that is valid JSON of the wrong shape', () => {
  let errors: string[];

  beforeEach(() => {
    mkdirSync(join(root, 'students'), { recursive: true });
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  afterEach(() => vi.restoreAllMocks());

  const write = (json: string) => writeFileSync(join(root, 'students', 'sabien.json'), json);

  it('reads a truncated-then-repaired entry as defaults instead of throwing a bare TypeError', () => {
    // Every student tool reads this file and then reaches into .level / .evidence.length, so an
    // unchecked cast made one hand-edit fail all of them at once with no mention of the file.
    write('{"chain-rule": {"level": "mastered"}}');
    const s = store.readStudent('sabien');
    expect(s['chain-rule'].evidence).toEqual([]);
    expect(s['chain-rule'].misconceptions).toEqual([]);
    expect(s['chain-rule'].level).toBe('mastered');
    expect(errors.join('\n')).toContain('students/sabien.json');
  });

  it('never drops an entry it could not read — record_evidence writes this state straight back', () => {
    write('{"chain-rule": 7, "limits": null}');
    expect(Object.keys(store.readStudent('sabien')).sort()).toEqual(['chain-rule', 'limits']);
  });

  it('a repaired last_reinforced reads as the epoch, so a broken record cannot mint standing', () => {
    write('{"chain-rule": {"level": "mastered", "evidence": [], "misconceptions": []}}');
    const m = store.readStudent('sabien')['chain-rule'];
    expect(m.last_reinforced).toBe('1970-01-01');
    expect(effectiveLevel(m, new Date('2026-07-10'))).toBe('practicing'); // fully decayed, not mastered
  });

  it('an unknown level is not trusted as a level', () => {
    write('{"chain-rule": {"level": "expert", "evidence": [], "misconceptions": [], "last_reinforced": "2026-07-10"}}');
    expect(store.readStudent('sabien')['chain-rule'].level).toBe('unseen');
  });

  it('drops evidence entries that are not objects', () => {
    // restsOnRubric walks evidence[i].kind; a null element there crashed it.
    write('{"chain-rule": {"level": "exposed", "evidence": [null, {"date": "2026-07-10", "kind": "exposed", "note": "n"}], "misconceptions": [], "last_reinforced": "2026-07-10"}}');
    expect(store.readStudent('sabien')['chain-rule'].evidence).toHaveLength(1);
    expect(errors.join('\n')).toContain('dropped 1');
  });

  it('a JSON value that is not a mastery map at all reads as an empty student, loudly', () => {
    write('[1, 2, 3]');
    expect(store.readStudent('sabien')).toEqual({});
    expect(errors.join('\n')).toContain('not a mastery map');
  });

  it('still throws on JSON that does not parse — that is corruption, not a shape we can repair', () => {
    write('{not json');
    expect(() => store.readStudent('sabien')).toThrow(/student file corrupt/);
  });
});

describe('VaultStore — atomicWrite failure', () => {
  it('leaves no .tmp sibling in the vault when the rename fails', () => {
    // The temp lives next to the real file inside the learner's Obsidian vault; a failed write
    // must not leave litter there for them to find. Rename onto a directory is the reachable
    // failure — the power-loss case itself needs the machine to die.
    mkdirSync(join(root, 'students', 'sabien.json'), { recursive: true });
    expect(() => store.writeStudent('sabien', {})).toThrow();
    expect(existsSync(join(root, 'students', 'sabien.json.tmp'))).toBe(false);
  });
});
