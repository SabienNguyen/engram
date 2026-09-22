import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import matter from 'gray-matter';
import { parsePage, serializePage, slugify, unparsedFrontmatter } from './parsePage.js';
import { LEVELS } from '../types.js';
import type { Evidence, MasteryLevel, Page, PageMastery, PageMeta, StudentState } from '../types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A students/*.json entry that isn't the shape we write — hand-edited in a text editor, or written
// by a different version of this server. Every student tool reads the file and then reaches
// straight into `.level` / `.evidence.length`, so the unchecked cast this replaces turned one
// stray edit into a bare TypeError out of all of them at once. Two rules make the repair safe:
// nothing is dropped (record_evidence writes back exactly what readStudent returned, so dropping a
// key would DELETE that page's history instead of resetting it), and an unreadable
// `last_reinforced` reads as the epoch rather than today — a repair must never hand back standing
// the learner hasn't earned.
const EPOCH = '1970-01-01';

function coerceMastery(slug: string, v: unknown, repairs: string[]): PageMastery {
  if (!isRecord(v)) {
    repairs.push(`${slug}: not an object`);
    return { level: 'unseen', evidence: [], misconceptions: [], last_reinforced: EPOCH };
  }
  let level: MasteryLevel = 'unseen';
  if (LEVELS.includes(v.level as MasteryLevel)) level = v.level as MasteryLevel;
  else repairs.push(`${slug}.level`);

  let evidence: Evidence[] = [];
  if (Array.isArray(v.evidence)) {
    // A non-object element crashes restsOnRubric's `m.evidence[i].kind` walk, so it can't stay.
    evidence = v.evidence.filter(isRecord) as unknown as Evidence[];
    const dropped = v.evidence.length - evidence.length;
    if (dropped > 0) repairs.push(`${slug}.evidence: dropped ${dropped} non-object entries`);
  } else repairs.push(`${slug}.evidence`);

  let misconceptions: string[] = [];
  if (Array.isArray(v.misconceptions)) {
    // A non-string element would stringify to "[object Object]" and read back as a misconception
    // the learner never had. Drop it and say so, rather than coerce it into a plausible lie.
    misconceptions = v.misconceptions.filter((m): m is string => typeof m === 'string');
    const dropped = v.misconceptions.length - misconceptions.length;
    if (dropped > 0) repairs.push(`${slug}.misconceptions: dropped ${dropped} non-string entries`);
  } else repairs.push(`${slug}.misconceptions`);

  let last_reinforced = EPOCH;
  if (typeof v.last_reinforced === 'string') last_reinforced = v.last_reinforced;
  else repairs.push(`${slug}.last_reinforced`);

  // Unmodeled keys ride through. readStudent's result is what writeStudent persists, so rebuilding
  // a fresh object from the four fields we know would DELETE anything a newer version of this
  // server wrote — which is one of the cases this repair path exists to survive, not to cause.
  // Same stance PageMeta.extra takes for frontmatter.
  return { ...v, level, evidence, misconceptions, last_reinforced } as PageMastery;
}

export class VaultStore {
  private fileBySlug = new Map<string, string>(); // slug -> absolute path

  constructor(readonly root: string) {}

  private dir(...parts: string[]): string {
    const d = join(this.root, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Resolve `${name}${ext}` as a single file directly inside `dir`, refusing any name that would
   *  escape it — a `/`, a `..`, an absolute path. Page/path filenames are already safe because they
   *  come from slugify ([a-z0-9-] only); this guards the FREE-STRING names — student ids, raw
   *  filenames — that reach the filesystem straight from an MCP argument. This server is a reusable
   *  MCP endpoint, so it can't assume its client sanitised them (the harness does, but another
   *  client calling record_evidence with student "../../x" must not write outside the vault). */
  private fileWithin(dir: string, name: string, ext: string): string {
    const f = join(dir, `${name}${ext}`);
    const rel = relative(dir, f);
    if (rel.startsWith('..') || rel.includes(sep)) {
      throw new Error(`invalid name: ${JSON.stringify(name)} would escape ${relative(this.root, dir) || '.'}/`);
    }
    return f;
  }

  /** Crash-safe write: a plain writeFileSync opens with O_TRUNC, so it empties the file BEFORE
   *  writing — a process death in that window (container reclaim, OOM kill, power loss) leaves a
   *  truncated or empty file. Used by every write in this store, not just the student one: a page
   *  is regenerable, but appendReviewLog is a read-modify-truncate-write of the WHOLE file, so a
   *  crash there doesn't lose the one new line, it loses every link's provenance ever recorded —
   *  and readStudent already throws on a JSON-corrupt file rather than silently returning {}, so a
   *  torn students/ write must not happen either. Write a sibling temp and rename over the target:
   *  rename is atomic on POSIX, so a reader ever sees only the intact old file or the complete new
   *  one. The temp is a sibling (same directory, same filesystem) so the rename can't fail
   *  cross-device.
   *
   *  The fsync is what makes that hold across POWER LOSS and not just process death: without it
   *  the rename can reach disk while the temp's bytes are still in page cache, which publishes a
   *  half-written file under the real name — the exact failure this method exists to prevent. We
   *  fsync the temp, not the containing directory, so the outcome after a power cut is old-or-new:
   *  a lost rename leaves the intact previous file. Never a torn one.
   *
   *  The temp is unlinked if anything throws: a failed rename used to leave a `.tmp` sibling
   *  sitting in the learner's Obsidian vault for them to find. */
  private atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    let fd: number | undefined = openSync(tmp, 'w');
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
      // Cleared BEFORE the close, not after: a throwing closeSync would otherwise leave fd set and
      // the catch would close it a second time, and that EBADF escapes before the unlink and
      // before the rethrow — losing both the cleanup and the real error.
      const open = fd;
      fd = undefined;
      closeSync(open);
      renameSync(tmp, file);
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
      // Best-effort: the write failure is what the caller needs to hear, not an ENOENT from the
      // cleanup of a temp that never got created.
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw e;
    }
  }

  private scanMd(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: false })
      .map(String)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f));
  }

  loadPages(): Map<string, Page> {
    const pagesDir = join(this.root, 'pages');
    const pages = new Map<string, Page>();
    this.fileBySlug.clear();
    for (const file of this.scanMd(pagesDir).sort()) {
      const rel = relative(pagesDir, file);
      const slug = slugify(rel.split(sep).pop()!.replace(/\.md$/, ''));
      const domain = dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/');
      if (pages.has(slug)) {
        pages.get(slug)!.warnings.push(`duplicate slug: ${rel} skipped`);
        continue;
      }
      pages.set(slug, parsePage(slug, domain, readFileSync(file, 'utf8')));
      this.fileBySlug.set(slug, file);
    }
    return pages;
  }

  writePage(slug: string, meta: PageMeta, body: string, domain = ''): Page {
    if (this.fileBySlug.size === 0) this.loadPages();
    const file =
      this.fileBySlug.get(slug) ??
      join(this.dir('pages', ...(domain ? domain.split('/') : [])), `${slug}.md`);
    // A page whose YAML doesn't parse comes back from parsePage with EMPTY meta (it degrades
    // instead of throwing so one bad page can't break every read of the vault). Serializing that
    // back wrote the emptiness in as truth: a learner who left a tab in the frontmatter while
    // editing in Obsidian lost prereqs, sources, difficulty and status the next time the tutor
    // touched the page, and the tutor then read it as unlinked and unsourced. Keep the bytes we
    // couldn't read, write only the body, and say so — the parse error rides back out on the
    // returned page's `warnings`, which read_page and write_page already surface.
    const keep = existsSync(file) ? unparsedFrontmatter(readFileSync(file, 'utf8')) : undefined;
    if (keep !== undefined) {
      console.error(
        `[vault] ${relative(this.root, file)}: frontmatter does not parse — kept verbatim, metadata NOT updated by this write`
      );
    }
    this.atomicWrite(file, keep === undefined ? serializePage(meta, body) : `---\n${keep}\n---\n${body}`);
    this.fileBySlug.set(slug, file);
    return parsePage(slug, domain, readFileSync(file, 'utf8'));
  }

  createStub(slug: string): Page {
    if (this.loadPages().has(slug)) return this.loadPages().get(slug)!;
    const title = slug.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
    return this.writePage(
      slug,
      { title, prereqs: [], deepens: [], tags: [], difficulty: 3, status: 'stub', sources: [], authors: [] },
      '_Stub created by link validation._'
    );
  }

  readStudent(name: string): StudentState {
    const f = this.fileWithin(join(this.root, 'students'), name, '.json');
    if (!existsSync(f)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`student file corrupt: students/${name}.json — ${msg}`);
    }
    // Valid JSON of the wrong shape used to sail through the cast above — see coerceMastery.
    if (!isRecord(parsed)) {
      console.error(
        `[vault] students/${name}.json is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not a mastery map — reading as an empty student`
      );
      return {};
    }
    const repairs: string[] = [];
    const state: StudentState = {};
    for (const [slug, v] of Object.entries(parsed)) state[slug] = coerceMastery(slug, v, repairs);
    if (repairs.length > 0) {
      console.error(`[vault] students/${name}.json: unrecognised shape, read as defaults — ${repairs.join(', ')}`);
    }
    return state;
  }

  writeStudent(name: string, s: StudentState): void {
    // Atomic: a torn write here corrupts the learner's entire mastery history, which nothing can
    // regenerate (unlike pages, which the tutor can rewrite). See atomicWrite.
    this.atomicWrite(this.fileWithin(this.dir('students'), name, '.json'), JSON.stringify(s, null, 2));
  }

  appendReviewLog(line: string): void {
    const f = join(this.root, 'review-log.md');
    const header = '# Review Log\n\n';
    const existing = existsSync(f) ? readFileSync(f, 'utf8').replace(header, '') : '';
    // The log is newest-first for a human skimming it (spec: "every auto-accepted link, newest
    // first"), so the new line goes at the TOP — an O(1) append would reverse the order the
    // learner reads. That makes this a read-modify-truncate-write of the WHOLE log, not an append
    // of one line: a torn write here doesn't cost the new entry, it costs every link's provenance
    // ever recorded. Hence atomicWrite.
    this.atomicWrite(f, header + line + '\n' + existing);
  }

  readRationales(): Record<string, string> {
    const f = join(this.root, '.index', 'rationales.json');
    if (!existsSync(f)) return {};
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  saveRationale(key: string, rationale: string): void {
    const all = this.readRationales();
    all[key] = rationale;
    this.atomicWrite(join(this.dir('.index'), 'rationales.json'), JSON.stringify(all, null, 2));
  }

  listRaw(): string[] {
    const d = join(this.root, 'raw');
    return existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith('.')) : [];
  }

  readRaw(name: string): string {
    const f = this.fileWithin(join(this.root, 'raw'), name, '');
    if (!existsSync(f)) throw new Error(`raw file not found: ${name}`);
    return readFileSync(f, 'utf8');
  }

  listPathDocs(): { slug: string; title: string; pages: string[] }[] {
    return this.scanMd(join(this.root, 'paths')).sort().map((file) => {
      const { data } = matter(readFileSync(file, 'utf8'));
      const slug = slugify(file.split(sep).pop()!.replace(/\.md$/, ''));
      return {
        slug,
        title: typeof data.title === 'string' ? data.title : slug,
        pages: Array.isArray(data.pages) ? data.pages.map(String) : [],
      };
    });
  }

  readPathDoc(slug: string) {
    const f = join(this.root, 'paths', `${slug}.md`);
    if (!existsSync(f)) return undefined;
    const { data, content } = matter(readFileSync(f, 'utf8'));
    return {
      slug,
      title: typeof data.title === 'string' ? data.title : slug,
      pages: Array.isArray(data.pages) ? data.pages.map(String) : [],
      body: content,
    };
  }

  writePathDoc(slug: string, title: string, pages: string[], body: string): void {
    this.atomicWrite(join(this.dir('paths'), `${slug}.md`), matter.stringify(body, { title, pages }));
  }
}
