import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import matter from 'gray-matter';
import { parsePage, serializePage, slugify } from './parsePage.js';
import type { Page, PageMeta, StudentState } from '../types.js';

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
   *  truncated or empty file. For regenerable content that's a nuisance; for the student state it
   *  is the one irreplaceable thing this vault holds, and readStudent throws on a corrupt file
   *  rather than silently returning {}. Write a sibling temp and rename over the target: rename is
   *  atomic on POSIX, so a reader ever sees only the intact old file or the complete new one. The
   *  temp is a sibling (same directory, same filesystem) so the rename can't fail cross-device; a
   *  temp left by a crash mid-write is harmless — the next write overwrites it, readers never look
   *  at it. */
  private atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
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
    writeFileSync(file, serializePage(meta, body));
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
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as StudentState;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`student file corrupt: students/${name}.json — ${msg}`);
    }
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
    writeFileSync(f, header + line + '\n' + existing);
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
    writeFileSync(join(this.dir('.index'), 'rationales.json'), JSON.stringify(all, null, 2));
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
    writeFileSync(join(this.dir('paths'), `${slug}.md`), matter.stringify(body, { title, pages }));
  }
}
