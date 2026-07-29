# Engram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution model: fable-plan-sonnet-execute (one Sonnet subagent per task, main session reviews).

**Goal:** A TypeScript MCP server exposing a markdown teaching-vault (linked pages, curated paths, evidence-graded student model) so any MCP agent can tutor from it.

**Architecture:** Plain markdown vault is the source of truth; `.index/` holds rebuildable caches (embeddings, rationales). The server is memory + graph queries only. LLM judgment (link verification, source compilation) is delegated to the *calling agent*: tools return candidate lists plus "contract" instruction text; the agent judges and calls back (`link_pages`, `write_page`). Spec: `docs/superpowers/specs/2026-07-10-engram-design.md`.

**Tech Stack:** TypeScript (strict, NodeNext), `@modelcontextprotocol/sdk` (stdio), `gray-matter`, `zod`, `vitest`, `tsx`. Embeddings via Ollama `nomic-embed-text` (pluggable, `fake` provider for tests).

## Global Constraints

- Node ≥ 20; ESM (`"type": "module"`); relative imports use `.js` extensions
- stdio transport only; vault root comes from env `LOREWEAVER_VAULT` (server exits with error if unset)
- Markdown is the source of truth; `.index/` is a rebuildable cache and is gitignored
- No API keys: embedding provider selected by env `LOREWEAVER_EMBEDDINGS` = `ollama` (default) | `fake` | `none`
- Decay defaults: `mastered` reads as `practicing` after 45 days unreinforced; `practicing` reads as `exposed` after 21 days; stored level is never mutated by decay
- `prereq` edges must stay a DAG; cycle ⇒ reject edge; hub warning at ≥ 20 inbound links
- Boundary rule: server never teaches; agent never parses markdown
- Slugs are globally unique kebab-case page basenames (folder = domain, not part of slug)
- All tool responses are JSON in a single text content block
- Malformed frontmatter never crashes: page loads as `draft` with warnings

---

### Task 1: Project scaffold + core types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`
- Test: `tests/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every type below, imported by all later tasks from `../src/types.js` — exact shapes matter.

- [ ] **Step 1: Scaffold config files**

`package.json`:
```json
{
  "name": "engram",
  "version": "0.1.0",
  "type": "module",
  "bin": { "engram": "dist/server.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "gray-matter": "^4.0.3",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`.gitignore`:
```
node_modules/
dist/
.index/
```

Run: `npm install`
Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

`tests/types.test.ts`:
```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — cannot resolve `../src/types.js`.

- [ ] **Step 4: Write `src/types.ts`**

```ts
export type LinkType = 'prereq' | 'deepens' | 'related';
export type PageStatus = 'stub' | 'draft' | 'solid';

export interface PageMeta {
  title: string;
  prereqs: string[]; // page slugs
  deepens: string[];
  tags: string[];
  difficulty: number; // 1-5
  status: PageStatus;
  sources: string[];
}

export interface Page {
  slug: string; // unique kebab-case basename, no extension
  domain: string; // folder under pages/, '' if flat
  meta: PageMeta;
  body: string; // markdown body without frontmatter
  inlineLinks: string[]; // [[wiki-link]] targets as slugs (deduped)
  warnings: string[]; // parse problems; non-empty forces status 'draft'
}

export interface Edge {
  src: string;
  dst: string;
  type: LinkType;
}

export type MasteryLevel = 'unseen' | 'exposed' | 'practicing' | 'mastered';
export const LEVELS: MasteryLevel[] = ['unseen', 'exposed', 'practicing', 'mastered'];

export const DECAY = { masteredDays: 45, practicingDays: 21 };

export type EvidenceKind =
  | 'exposed'
  | 'explained-correctly'
  | 'applied-correctly'
  | 'struggled'
  | 'misconception';

export interface Evidence {
  date: string; // ISO yyyy-mm-dd
  kind: EvidenceKind;
  note: string;
}

export interface PageMastery {
  level: MasteryLevel;
  evidence: Evidence[];
  misconceptions: string[];
  last_reinforced: string; // ISO yyyy-mm-dd
}

export type StudentState = Record<string, PageMastery>;

export interface LinkCandidate {
  src: string;
  dst: string;
  score: number; // 0..1
  via: 'semantic' | 'lexical';
}

export interface LessonSuggestion {
  slug: string;
  title: string;
  reason: 'review-due' | 'unmet-prereq' | 'frontier';
  detail: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/types.ts tests/types.test.ts
git commit -m "feat: scaffold project and core types"
```

---

### Task 2: Page parsing (frontmatter + wiki-links)

**Files:**
- Create: `src/vault/parsePage.ts`
- Test: `tests/parsePage.test.ts`

**Interfaces:**
- Consumes: `Page`, `PageMeta`, `PageStatus` from `../types.js`
- Produces: `slugify(name: string): string`; `parsePage(slug: string, domain: string, raw: string): Page`; `serializePage(meta: PageMeta, body: string): string`

- [ ] **Step 1: Write the failing test**

`tests/parsePage.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parsePage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/parsePage.ts`**

```ts
import matter from 'gray-matter';
import type { Page, PageMeta, PageStatus } from '../types.js';

const WIKI_LINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const STATUSES: PageStatus[] = ['stub', 'draft', 'solid'];

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function strArray(v: unknown, field: string, warnings: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map(slugify);
  warnings.push(`invalid ${field}: expected string array`);
  return [];
}

export function parsePage(slug: string, domain: string, raw: string): Page {
  const warnings: string[] = [];
  let data: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    data = (parsed.data as Record<string, unknown>) ?? {};
    body = parsed.content;
  } catch (e) {
    warnings.push(`frontmatter parse error: ${(e as Error).message}`);
  }

  const difficulty =
    typeof data.difficulty === 'number' && data.difficulty >= 1 && data.difficulty <= 5
      ? data.difficulty
      : (data.difficulty !== undefined && warnings.push('invalid difficulty: expected 1-5'), 3);

  let status: PageStatus = 'draft';
  if (data.status === undefined) {
    // default draft, no warning
  } else if (STATUSES.includes(data.status as PageStatus)) {
    status = data.status as PageStatus;
  } else {
    warnings.push(`invalid status: ${String(data.status)}`);
  }

  const meta: PageMeta = {
    title: typeof data.title === 'string' ? data.title : slug,
    prereqs: strArray(data.prereqs, 'prereqs', warnings),
    deepens: strArray(data.deepens, 'deepens', warnings),
    tags: strArray(data.tags, 'tags', warnings),
    difficulty,
    status,
    sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
  };
  if (warnings.length > 0 && meta.status === 'solid') meta.status = 'draft';

  const inlineLinks = [...new Set([...body.matchAll(WIKI_LINK)].map((m) => slugify(m[1])))];
  return { slug, domain, meta, body, inlineLinks, warnings };
}

export function serializePage(meta: PageMeta, body: string): string {
  return matter.stringify(body, meta as unknown as Record<string, unknown>);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parsePage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/parsePage.ts tests/parsePage.test.ts
git commit -m "feat: page parsing with frontmatter, wiki-links, graceful degradation"
```

---

### Task 3: VaultStore (pages, students, paths, raw, review-log, rationales)

**Files:**
- Create: `src/vault/vaultStore.ts`
- Test: `tests/vaultStore.test.ts`

**Interfaces:**
- Consumes: `parsePage`, `serializePage`, `slugify` from `./parsePage.js`; types from `../types.js`
- Produces (class `VaultStore`, constructed with vault root dir):
  - `loadPages(): Map<string, Page>` — scans `pages/**/*.md`; duplicate slug ⇒ later file skipped with warning pushed onto the kept page
  - `writePage(slug: string, meta: PageMeta, body: string, domain?: string): Page` — creates or overwrites; new pages go to `pages/<domain>/<slug>.md` (domain `''` ⇒ `pages/<slug>.md`); existing pages keep their file
  - `createStub(slug: string): Page` — writes `status: stub` page titled from slug, body `_Stub created by link validation._`; no-op if page exists
  - `readStudent(name: string): StudentState` (missing file ⇒ `{}`), `writeStudent(name: string, s: StudentState): void`
  - `appendReviewLog(line: string): void` — prepends under a `# Review Log` heading in `review-log.md`
  - `readRationales(): Record<string, string>`, `saveRationale(key: string, rationale: string): void` — `.index/rationales.json`, key format `` `${src}->${dst}:${type}` ``
  - `listRaw(): string[]`, `readRaw(name: string): string`
  - `listPathDocs(): { slug: string; title: string; pages: string[] }[]`, `readPathDoc(slug: string): { slug: string; title: string; pages: string[]; body: string } | undefined`, `writePathDoc(slug: string, title: string, pages: string[], body: string): void` — files in `paths/`, frontmatter `title` + `pages`

- [ ] **Step 1: Write the failing test**

`tests/vaultStore.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vaultStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/vault/vaultStore.ts`**

```ts
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
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
      { title, prereqs: [], deepens: [], tags: [], difficulty: 3, status: 'stub', sources: [] },
      '_Stub created by link validation._'
    );
  }

  readStudent(name: string): StudentState {
    const f = join(this.root, 'students', `${name}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as StudentState) : {};
  }

  writeStudent(name: string, s: StudentState): void {
    writeFileSync(join(this.dir('students'), `${name}.json`), JSON.stringify(s, null, 2));
  }

  appendReviewLog(line: string): void {
    const f = join(this.root, 'review-log.md');
    const header = '# Review Log\n\n';
    const existing = existsSync(f) ? readFileSync(f, 'utf8').replace(header, '') : '';
    writeFileSync(f, header + line + '\n' + existing);
  }

  readRationales(): Record<string, string> {
    const f = join(this.root, '.index', 'rationales.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {};
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
    return readFileSync(join(this.root, 'raw', name), 'utf8');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vaultStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/vaultStore.ts tests/vaultStore.test.ts
git commit -m "feat: VaultStore for pages, students, paths, raw sources, review log"
```

---

### Task 4: Graph edges + DAG validation

**Files:**
- Create: `src/graph/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: `Page`, `Edge` from `../types.js`
- Produces:
  - `buildEdges(pages: Map<string, Page>): Edge[]` — from `meta.prereqs` (`prereq`), `meta.deepens` (`deepens`), `inlineLinks` (`related`); excludes self-links; dedupes by `src|dst|type`
  - `missingTargets(pages: Map<string, Page>, edges: Edge[]): string[]` — dst slugs with no page
  - `wouldCreateCycle(edges: Edge[], src: string, dst: string): boolean` — for a NEW `prereq` edge src→dst ("src requires dst"): true iff dst transitively requires src
  - `graphWarnings(pages: Map<string, Page>, edges: Edge[]): string[]` — `orphan: <slug>` for pages with no inbound edges of any type, `hub: <slug> (<n> inbound)` for ≥ 20 inbound

- [ ] **Step 1: Write the failing test**

`tests/graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildEdges, missingTargets, wouldCreateCycle, graphWarnings } from '../src/graph/graph.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

function vault(...entries: [string, string][]): Map<string, Page> {
  return new Map(entries.map(([slug, raw]) => [slug, parsePage(slug, '', raw)]));
}

const pages = vault(
  ['backprop', '---\nprereqs: [chain-rule]\ndeepens: [jacobians]\n---\nSee [[chain-rule]] and [[dp]].'],
  ['chain-rule', '---\nprereqs: [derivatives]\n---\nbody'],
  ['jacobians', 'body'],
  ['derivatives', 'body'],
);

describe('graph', () => {
  it('builds typed, deduped edges', () => {
    const edges = buildEdges(pages);
    expect(edges).toContainEqual({ src: 'backprop', dst: 'chain-rule', type: 'prereq' });
    expect(edges).toContainEqual({ src: 'backprop', dst: 'jacobians', type: 'deepens' });
    expect(edges).toContainEqual({ src: 'backprop', dst: 'dp', type: 'related' });
    // inline [[chain-rule]] does NOT duplicate the prereq edge as related? It is a distinct type: related edge allowed.
    expect(edges.filter((e) => e.src === 'backprop' && e.dst === 'chain-rule')).toHaveLength(2);
  });

  it('finds missing targets', () => {
    expect(missingTargets(pages, buildEdges(pages))).toEqual(['dp']);
  });

  it('detects prereq cycles transitively', () => {
    const edges = buildEdges(pages);
    // derivatives -> backprop would close: backprop -> chain-rule -> derivatives -> backprop
    expect(wouldCreateCycle(edges, 'derivatives', 'backprop')).toBe(true);
    expect(wouldCreateCycle(edges, 'jacobians', 'derivatives')).toBe(false);
    expect(wouldCreateCycle(edges, 'x', 'x')).toBe(true);
  });

  it('warns on orphans and hubs', () => {
    const w = graphWarnings(pages, buildEdges(pages));
    expect(w).toContain('orphan: backprop');
    expect(w.some((x) => x.startsWith('hub:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/graph/graph.ts`**

```ts
import type { Edge, Page } from '../types.js';

export function buildEdges(pages: Map<string, Page>): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const add = (src: string, dst: string, type: Edge['type']) => {
    if (src === dst) return;
    const key = `${src}|${dst}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ src, dst, type });
  };
  for (const p of pages.values()) {
    for (const d of p.meta.prereqs) add(p.slug, d, 'prereq');
    for (const d of p.meta.deepens) add(p.slug, d, 'deepens');
    for (const d of p.inlineLinks) add(p.slug, d, 'related');
  }
  return edges;
}

export function missingTargets(pages: Map<string, Page>, edges: Edge[]): string[] {
  return [...new Set(edges.filter((e) => !pages.has(e.dst)).map((e) => e.dst))];
}

/** New prereq edge src->dst means "src requires dst". Cycle iff dst transitively requires src. */
export function wouldCreateCycle(edges: Edge[], src: string, dst: string): boolean {
  if (src === dst) return true;
  const requires = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'prereq') continue;
    (requires.get(e.src) ?? requires.set(e.src, []).get(e.src)!).push(e.dst);
  }
  const stack = [dst];
  const visited = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === src) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    stack.push(...(requires.get(cur) ?? []));
  }
  return false;
}

export function graphWarnings(pages: Map<string, Page>, edges: Edge[]): string[] {
  const inbound = new Map<string, number>();
  for (const e of edges) inbound.set(e.dst, (inbound.get(e.dst) ?? 0) + 1);
  const warnings: string[] = [];
  for (const slug of pages.keys()) {
    const n = inbound.get(slug) ?? 0;
    if (n === 0) warnings.push(`orphan: ${slug}`);
    if (n >= 20) warnings.push(`hub: ${slug} (${n} inbound)`);
  }
  return warnings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graph.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/graph/graph.ts tests/graph.test.ts
git commit -m "feat: typed edge graph with DAG cycle detection and health warnings"
```

---

### Task 5: Embedding providers + index

**Files:**
- Create: `src/embeddings/provider.ts`, `src/embeddings/index.ts`
- Test: `tests/embeddings.test.ts`

**Interfaces:**
- Consumes: `Page` from `../types.js`
- Produces (`provider.ts`):
  - `interface EmbeddingProvider { name: string; embed(texts: string[]): Promise<number[][]> }`
  - `class OllamaProvider implements EmbeddingProvider` — `constructor(model = 'nomic-embed-text', baseUrl = 'http://localhost:11434')`; POSTs `{ model, prompt }` to `/api/embeddings` per text; throws `Error('ollama unreachable: …')` on fetch failure
  - `class FakeProvider implements EmbeddingProvider` — deterministic 32-dim char-trigram hashing, L2-normalized; similar texts ⇒ similar vectors
  - `getProvider(env = process.env): EmbeddingProvider | null` — `LOREWEAVER_EMBEDDINGS`: `'none'` ⇒ null, `'fake'` ⇒ FakeProvider, else OllamaProvider
- Produces (`index.ts`):
  - `cosine(a: number[], b: number[]): number`
  - `class EmbeddingIndex` — `constructor(indexDir: string, provider: EmbeddingProvider)`; persists `<indexDir>/embeddings.json` as `{ provider: string, entries: Record<slug, { hash: string, vector: number[] }> }`
    - `async sync(pages: Map<string, Page>): Promise<void>` — sha256 of `title\n\nbody`; re-embeds changed/new, drops deleted, saves
    - `similarTo(slug: string, k: number, filter?: (slug: string) => boolean): { slug: string; score: number }[]` — excludes `slug` itself
    - `similarToMany(slugs: string[], k: number, filter?: (slug: string) => boolean): { slug: string; score: number }[]` — score = max cosine to any of `slugs`; excludes `slugs` themselves

- [ ] **Step 1: Write the failing test**

`tests/embeddings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider, getProvider } from '../src/embeddings/provider.js';
import { EmbeddingIndex, cosine } from '../src/embeddings/index.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

const pages = new Map<string, Page>([
  ['gradient-descent', parsePage('gradient-descent', '', 'iterative optimization stepping along gradients')],
  ['kelly-criterion', parsePage('kelly-criterion', '', 'iterative optimization of bet size fraction')],
  ['baking-bread', parsePage('baking-bread', '', 'flour water yeast oven proofing crust')],
]);

describe('embeddings', () => {
  it('FakeProvider is deterministic and rates similar texts closer', async () => {
    const p = new FakeProvider();
    const [a1] = await p.embed(['iterative optimization']);
    const [a2] = await p.embed(['iterative optimization']);
    expect(a1).toEqual(a2);
    const [gd, kelly, bread] = await p.embed([
      'iterative optimization stepping along gradients',
      'iterative optimization of bet size fraction',
      'flour water yeast oven proofing crust',
    ]);
    expect(cosine(gd, kelly)).toBeGreaterThan(cosine(gd, bread));
  });

  it('getProvider honors env', () => {
    expect(getProvider({ LOREWEAVER_EMBEDDINGS: 'none' })).toBeNull();
    expect(getProvider({ LOREWEAVER_EMBEDDINGS: 'fake' })?.name).toBe('fake');
    expect(getProvider({})?.name).toBe('ollama');
  });

  it('index syncs, persists, and ranks neighbors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-idx-'));
    const idx = new EmbeddingIndex(dir, new FakeProvider());
    await idx.sync(pages);
    const near = idx.similarTo('gradient-descent', 2);
    expect(near[0].slug).toBe('kelly-criterion');
    // reload from disk: no re-embed needed, same results
    const idx2 = new EmbeddingIndex(dir, new FakeProvider());
    await idx2.sync(pages);
    expect(idx2.similarTo('gradient-descent', 1)[0].slug).toBe('kelly-criterion');
    // similarToMany with filter
    const many = idx2.similarToMany(['gradient-descent'], 5, (s) => s !== 'baking-bread');
    expect(many.map((m) => m.slug)).toEqual(['kelly-criterion']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/embeddings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/embeddings/provider.ts`**

```ts
export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class OllamaProvider implements EmbeddingProvider {
  name = 'ollama';
  constructor(
    private model = 'nomic-embed-text',
    private baseUrl = 'http://localhost:11434'
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const prompt of texts) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt }),
        });
      } catch (e) {
        throw new Error(`ollama unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) throw new Error(`ollama error: HTTP ${res.status}`);
      out.push((await res.json()).embedding as number[]);
    }
    return out;
  }
}

export class FakeProvider implements EmbeddingProvider {
  name = 'fake';
  private static DIM = 32;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(FakeProvider.DIM).fill(0);
      const s = t.toLowerCase();
      for (let i = 0; i < s.length - 2; i++) {
        let h = 0;
        for (let j = i; j < i + 3; j++) h = (h * 31 + s.charCodeAt(j)) >>> 0;
        v[h % FakeProvider.DIM] += 1;
      }
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export function getProvider(
  env: Record<string, string | undefined> = process.env
): EmbeddingProvider | null {
  const mode = env.LOREWEAVER_EMBEDDINGS ?? 'ollama';
  if (mode === 'none') return null;
  if (mode === 'fake') return new FakeProvider();
  return new OllamaProvider();
}
```

- [ ] **Step 4: Implement `src/embeddings/index.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from '../types.js';
import type { EmbeddingProvider } from './provider.js';

interface Stored {
  provider: string;
  entries: Record<string, { hash: string; vector: number[] }>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export class EmbeddingIndex {
  private data: Stored;
  private file: string;

  constructor(indexDir: string, private provider: EmbeddingProvider) {
    mkdirSync(indexDir, { recursive: true });
    this.file = join(indexDir, 'embeddings.json');
    this.data = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Stored)
      : { provider: provider.name, entries: {} };
    if (this.data.provider !== provider.name) this.data = { provider: provider.name, entries: {} };
  }

  async sync(pages: Map<string, Page>): Promise<void> {
    const wanted = new Map<string, string>(); // slug -> hash
    for (const p of pages.values()) {
      wanted.set(p.slug, createHash('sha256').update(`${p.meta.title}\n\n${p.body}`).digest('hex'));
    }
    for (const slug of Object.keys(this.data.entries)) {
      if (!wanted.has(slug)) delete this.data.entries[slug];
    }
    const stale = [...wanted].filter(([slug, hash]) => this.data.entries[slug]?.hash !== hash);
    if (stale.length) {
      const vectors = await this.provider.embed(
        stale.map(([slug]) => {
          const p = pages.get(slug)!;
          return `${p.meta.title}\n\n${p.body}`;
        })
      );
      stale.forEach(([slug, hash], i) => (this.data.entries[slug] = { hash, vector: vectors[i] }));
    }
    writeFileSync(this.file, JSON.stringify(this.data));
  }

  similarTo(slug: string, k: number, filter?: (slug: string) => boolean) {
    return this.similarToMany([slug], k, filter);
  }

  similarToMany(slugs: string[], k: number, filter?: (slug: string) => boolean) {
    const anchors = slugs.map((s) => this.data.entries[s]?.vector).filter(Boolean) as number[][];
    if (!anchors.length) return [];
    const exclude = new Set(slugs);
    return Object.entries(this.data.entries)
      .filter(([slug]) => !exclude.has(slug) && (!filter || filter(slug)))
      .map(([slug, { vector }]) => ({
        slug,
        score: Math.max(...anchors.map((a) => cosine(a, vector))),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/embeddings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/embeddings tests/embeddings.test.ts
git commit -m "feat: pluggable embedding providers with hash-cached vector index"
```

---

### Task 6: Link proposal + verify contract

**Files:**
- Create: `src/linking/propose.ts`
- Test: `tests/propose.test.ts`

**Interfaces:**
- Consumes: `EmbeddingIndex` from `../embeddings/index.js`; `Edge`, `Page`, `LinkCandidate` from `../types.js`
- Produces:
  - `proposeLinks(page: Page, pages: Map<string, Page>, edges: Edge[], index: EmbeddingIndex | null): LinkCandidate[]` — semantic top-8 (`via: 'semantic'`, score = cosine) when index present; lexical candidates (`via: 'lexical'`, score = 0.5): any other page whose title (slugified tokens joined by space) appears in `page.body.toLowerCase()` or whose body contains the page's title, checked case-insensitively; excludes self, existing edges in either direction (any type), and dedupes by dst keeping highest score; caps at 10
  - `VERIFY_CONTRACT: string` — instruction text (see implementation, copy verbatim)

- [ ] **Step 1: Write the failing test**

`tests/propose.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeLinks, VERIFY_CONTRACT } from '../src/linking/propose.js';
import { EmbeddingIndex } from '../src/embeddings/index.js';
import { FakeProvider } from '../src/embeddings/provider.js';
import { buildEdges } from '../src/graph/graph.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

const pages = new Map<string, Page>([
  ['backprop', parsePage('backprop', '', '---\nprereqs: [chain-rule]\n---\nGradient flow uses the chain rule repeatedly.')],
  ['chain-rule', parsePage('chain-rule', '', 'Derivative of composed functions.')],
  ['gradient-descent', parsePage('gradient-descent', '', 'Gradient flow: step along gradients repeatedly.')],
  ['baking-bread', parsePage('baking-bread', '', 'flour water yeast oven')],
]);

describe('proposeLinks', () => {
  it('proposes semantic + lexical candidates, excluding self and existing edges', async () => {
    const idx = new EmbeddingIndex(mkdtempSync(join(tmpdir(), 'lw-')), new FakeProvider());
    await idx.sync(pages);
    const cands = proposeLinks(pages.get('backprop')!, pages, buildEdges(pages), idx);
    const dsts = cands.map((c) => c.dst);
    expect(dsts).toContain('gradient-descent');
    expect(dsts).not.toContain('backprop'); // self
    expect(dsts).not.toContain('chain-rule'); // existing prereq edge
    expect(cands.length).toBeLessThanOrEqual(10);
  });

  it('works lexical-only without an index', () => {
    const cands = proposeLinks(pages.get('gradient-descent')!, pages, buildEdges(pages), null);
    expect(cands.every((c) => c.via === 'lexical')).toBe(true);
  });

  it('contract demands a rationale and link_pages callback', () => {
    expect(VERIFY_CONTRACT).toContain('rationale');
    expect(VERIFY_CONTRACT).toContain('link_pages');
    expect(VERIFY_CONTRACT).toContain('prereq');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/propose.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/linking/propose.ts`**

```ts
import type { Edge, LinkCandidate, Page } from '../types.js';
import type { EmbeddingIndex } from '../embeddings/index.js';

export const VERIFY_CONTRACT = `You are the verify gate for proposed links. Judge each candidate INDEPENDENTLY:
Does a specific claim in the source page fail, or get materially enriched, without the target page?
- Accept ONLY if you can state a one-line rationale naming that specific dependency or enrichment.
- Pick the type: "prereq" (source cannot be understood without target — teaching order),
  "deepens" (optional depth / rabbit hole), "related" (lateral analogy or contrast).
- For each ACCEPTED candidate call the link_pages tool: { src, dst, type, rationale }.
- Silently drop candidates you cannot justify. Do not link for mere topical overlap.`;

export function proposeLinks(
  page: Page,
  pages: Map<string, Page>,
  edges: Edge[],
  index: EmbeddingIndex | null
): LinkCandidate[] {
  const connected = new Set<string>();
  for (const e of edges) {
    if (e.src === page.slug) connected.add(e.dst);
    if (e.dst === page.slug) connected.add(e.src);
  }
  const eligible = (slug: string) => slug !== page.slug && !connected.has(slug) && pages.has(slug);

  const byDst = new Map<string, LinkCandidate>();
  const offer = (c: LinkCandidate) => {
    const prev = byDst.get(c.dst);
    if (!prev || c.score > prev.score) byDst.set(c.dst, c);
  };

  if (index) {
    for (const { slug, score } of index.similarTo(page.slug, 8, eligible)) {
      offer({ src: page.slug, dst: slug, score, via: 'semantic' });
    }
  }

  const myBody = page.body.toLowerCase();
  const myTitle = page.meta.title.toLowerCase();
  for (const other of pages.values()) {
    if (!eligible(other.slug)) continue;
    const otherTitle = other.meta.title.toLowerCase();
    if (myBody.includes(otherTitle) || other.body.toLowerCase().includes(myTitle)) {
      offer({ src: page.slug, dst: other.slug, score: 0.5, via: 'lexical' });
    }
  }

  return [...byDst.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/propose.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/linking/propose.ts tests/propose.test.ts
git commit -m "feat: link candidate proposal with agent-side verify contract"
```

---

### Task 7: Student model (evidence + decay)

**Files:**
- Create: `src/student/model.ts`
- Test: `tests/student.test.ts`

**Interfaces:**
- Consumes: `DECAY`, `LEVELS`, `Evidence`, `EvidenceKind`, `MasteryLevel`, `PageMastery`, `StudentState` from `../types.js`
- Produces:
  - `effectiveLevel(m: PageMastery | undefined, now: Date): MasteryLevel` — undefined ⇒ `'unseen'`; `mastered` older than 45 days ⇒ `'practicing'`; `practicing` older than 21 days ⇒ `'exposed'`; stored value untouched
  - `applyEvidence(state: StudentState, slug: string, kind: EvidenceKind, note: string, now: Date, misconception?: string): StudentState` — returns NEW state object (no mutation); transition table below; always appends evidence and sets `last_reinforced`
  - `isKnown(level: MasteryLevel): boolean` — true for `practicing`/`mastered`

Transition table for `applyEvidence` (from = effective level at `now`):
| kind | new stored level |
|---|---|
| `exposed` | max(from, `exposed`) |
| `explained-correctly` / `applied-correctly` | one above from (cap `mastered`) |
| `struggled` | one below from (floor `exposed`) |
| `misconception` | unchanged (but misconception string appended if provided) |

- [ ] **Step 1: Write the failing test**

`tests/student.test.ts`:
```ts
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
});

describe('isKnown', () => {
  it('is true for practicing and mastered only', () => {
    expect(isKnown('practicing')).toBe(true);
    expect(isKnown('mastered')).toBe(true);
    expect(isKnown('exposed')).toBe(false);
    expect(isKnown('unseen')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/student.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/student/model.ts`**

```ts
import {
  DECAY, LEVELS,
} from '../types.js';
import type {
  EvidenceKind, MasteryLevel, PageMastery, StudentState,
} from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function idx(l: MasteryLevel): number {
  return LEVELS.indexOf(l);
}

export function effectiveLevel(m: PageMastery | undefined, now: Date): MasteryLevel {
  if (!m) return 'unseen';
  const staleDays = (now.getTime() - new Date(m.last_reinforced + 'T00:00:00Z').getTime()) / DAY_MS;
  if (m.level === 'mastered' && staleDays > DECAY.masteredDays) return 'practicing';
  if (m.level === 'practicing' && staleDays > DECAY.practicingDays) return 'exposed';
  return m.level;
}

export function isKnown(level: MasteryLevel): boolean {
  return level === 'practicing' || level === 'mastered';
}

export function applyEvidence(
  state: StudentState,
  slug: string,
  kind: EvidenceKind,
  note: string,
  now: Date,
  misconception?: string
): StudentState {
  const today = now.toISOString().slice(0, 10);
  const prev: PageMastery = state[slug] ?? {
    level: 'unseen', evidence: [], misconceptions: [], last_reinforced: today,
  };
  const from = effectiveLevel(state[slug], now);

  let level: MasteryLevel = prev.level;
  if (kind === 'exposed') level = LEVELS[Math.max(idx(from), idx('exposed'))];
  else if (kind === 'explained-correctly' || kind === 'applied-correctly')
    level = LEVELS[Math.min(idx(from) + 1, idx('mastered'))];
  else if (kind === 'struggled') level = LEVELS[Math.max(idx(from) - 1, idx('exposed'))];
  // 'misconception': level unchanged
  if (kind === 'exposed') level = LEVELS[Math.max(idx(level), idx(prev.level))]; // never downgrade on exposure

  return {
    ...state,
    [slug]: {
      level,
      evidence: [...prev.evidence, { date: today, kind, note }],
      misconceptions: misconception ? [...prev.misconceptions, misconception] : prev.misconceptions,
      last_reinforced: today,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/student.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/student/model.ts tests/student.test.ts
git commit -m "feat: evidence-graded student model with read-time decay"
```

---

### Task 8: Teaching queries (review-due, frontier, unmet prereqs, next_lessons, analogies)

**Files:**
- Create: `src/queries/queries.ts`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `effectiveLevel`, `isKnown` from `../student/model.js`; `EmbeddingIndex` from `../embeddings/index.js`; types from `../types.js`
- Produces:
  - `reviewDue(state: StudentState, pages: Map<string, Page>, now: Date): LessonSuggestion[]` — pages where stored level ≠ effective level; `detail` = `` `stored ${stored}, decayed to ${effective}` ``
  - `unmetPrereqs(goal: string, pages: Map<string, Page>, state: StudentState, now: Date): LessonSuggestion[]` — DFS over `meta.prereqs` from `goal` (goal excluded); every reachable page with effective level below `practicing`, deepest-first order (a prereq appears before pages that require it); skips slugs with no page; `detail` = `` `needed for ${goal}` ``
  - `frontier(state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null, now: Date, k: number): LessonSuggestion[]` — candidates: pages with effective level `unseen`/`exposed` whose prereqs are ALL effectively known (`isKnown`); ranked by `index.similarToMany(knownSlugs, …)` score when index present, else by `difficulty` ascending; `detail` = `` `near your known region (score ${score.toFixed(2)})` `` or `` `easiest unexplored (difficulty ${d})` ``
  - `nextLessons(state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null, now: Date, goal?: string, k = 3): LessonSuggestion[]` — concat: reviewDue (max 2) + (goal ? unmetPrereqs : frontier); dedupe by slug keeping first; cap `k`
  - `analogies(slug: string, state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null, now: Date, k = 3): { slug: string; title: string; score: number }[]` — student's effectively-known pages ranked by similarity to `slug`; `[]` without index

- [ ] **Step 1: Write the failing test**

`tests/queries.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reviewDue, unmetPrereqs, frontier, nextLessons, analogies,
} from '../src/queries/queries.js';
import { EmbeddingIndex } from '../src/embeddings/index.js';
import { FakeProvider } from '../src/embeddings/provider.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page, StudentState } from '../src/types.js';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const NOW = d('2026-07-10');

const pages = new Map<string, Page>([
  ['derivatives', parsePage('derivatives', '', '---\ntitle: Derivatives\ndifficulty: 1\n---\nrates of change of functions')],
  ['chain-rule', parsePage('chain-rule', '', '---\ntitle: Chain Rule\nprereqs: [derivatives]\ndifficulty: 2\n---\nderivative of composed functions rates of change')],
  ['backprop', parsePage('backprop', '', '---\ntitle: Backpropagation\nprereqs: [chain-rule]\ndifficulty: 3\n---\ngradients composed backwards through layers')],
  ['kelly', parsePage('kelly', '', '---\ntitle: Kelly Criterion\ndifficulty: 4\n---\nbet sizing by iterative fraction optimization')],
]);

const mastery = (level: any, last: string) => ({ level, evidence: [], misconceptions: [], last_reinforced: last });

let index: EmbeddingIndex;
beforeAll(async () => {
  index = new EmbeddingIndex(mkdtempSync(join(tmpdir(), 'lw-q-')), new FakeProvider());
  await index.sync(pages);
});

describe('queries', () => {
  it('reviewDue finds decayed pages only', () => {
    const state: StudentState = {
      derivatives: mastery('mastered', '2026-05-01'), // decayed
      'chain-rule': mastery('practicing', '2026-07-01'), // fresh
    };
    const due = reviewDue(state, pages, NOW);
    expect(due.map((s) => s.slug)).toEqual(['derivatives']);
    expect(due[0].reason).toBe('review-due');
  });

  it('unmetPrereqs walks the chain deepest-first', () => {
    const gaps = unmetPrereqs('backprop', pages, {}, NOW);
    expect(gaps.map((g) => g.slug)).toEqual(['derivatives', 'chain-rule']);
    expect(gaps[0].reason).toBe('unmet-prereq');
  });

  it('frontier only offers pages whose prereqs are known', () => {
    const state: StudentState = { derivatives: mastery('practicing', '2026-07-01') };
    const f = frontier(state, pages, index, NOW, 5);
    const slugs = f.map((s) => s.slug);
    expect(slugs).toContain('chain-rule'); // prereq (derivatives) known
    expect(slugs).not.toContain('backprop'); // chain-rule not known
    expect(slugs).not.toContain('derivatives'); // already known
  });

  it('nextLessons: goal mode = review + prereq gaps, deduped and capped', () => {
    const state: StudentState = { derivatives: mastery('mastered', '2026-05-01') };
    const out = nextLessons(state, pages, index, NOW, 'backprop', 3);
    expect(out[0]).toMatchObject({ slug: 'derivatives', reason: 'review-due' });
    expect(out.map((s) => s.slug)).toContain('chain-rule');
    expect(out.length).toBeLessThanOrEqual(3);
    const seen = new Set(out.map((s) => s.slug));
    expect(seen.size).toBe(out.length); // deduped
  });

  it('analogies rank known pages by similarity to the target', () => {
    const state: StudentState = {
      derivatives: mastery('practicing', '2026-07-01'),
      'chain-rule': mastery('mastered', '2026-07-01'),
    };
    const a = analogies('backprop', state, pages, index, NOW, 2);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((x) => ['derivatives', 'chain-rule'].includes(x.slug))).toBe(true);
    expect(analogies('backprop', state, pages, null, NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/queries/queries.ts`**

```ts
import { effectiveLevel, isKnown } from '../student/model.js';
import type { EmbeddingIndex } from '../embeddings/index.js';
import type { LessonSuggestion, Page, StudentState } from '../types.js';

function title(pages: Map<string, Page>, slug: string): string {
  return pages.get(slug)?.meta.title ?? slug;
}

function knownSlugs(state: StudentState, pages: Map<string, Page>, now: Date): string[] {
  return [...pages.keys()].filter((slug) => isKnown(effectiveLevel(state[slug], now)));
}

export function reviewDue(
  state: StudentState, pages: Map<string, Page>, now: Date
): LessonSuggestion[] {
  const out: LessonSuggestion[] = [];
  for (const [slug, m] of Object.entries(state)) {
    if (!pages.has(slug)) continue;
    const eff = effectiveLevel(m, now);
    if (eff !== m.level) {
      out.push({
        slug, title: title(pages, slug), reason: 'review-due',
        detail: `stored ${m.level}, decayed to ${eff}`,
      });
    }
  }
  return out;
}

export function unmetPrereqs(
  goal: string, pages: Map<string, Page>, state: StudentState, now: Date
): LessonSuggestion[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (slug: string) => {
    if (visited.has(slug)) return;
    visited.add(slug);
    for (const pre of pages.get(slug)?.meta.prereqs ?? []) visit(pre);
    if (slug !== goal && pages.has(slug) && !isKnown(effectiveLevel(state[slug], now))) {
      ordered.push(slug);
    }
  };
  visit(goal);
  return ordered.map((slug) => ({
    slug, title: title(pages, slug), reason: 'unmet-prereq' as const, detail: `needed for ${goal}`,
  }));
}

export function frontier(
  state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null,
  now: Date, k: number
): LessonSuggestion[] {
  const candidates = [...pages.values()].filter((p) => {
    const eff = effectiveLevel(state[p.slug], now);
    if (eff !== 'unseen' && eff !== 'exposed') return false;
    return p.meta.prereqs.every(
      (pre) => !pages.has(pre) || isKnown(effectiveLevel(state[pre], now))
    );
  });
  const known = knownSlugs(state, pages, now);
  if (index && known.length) {
    const eligible = new Set(candidates.map((c) => c.slug));
    return index
      .similarToMany(known, k, (slug) => eligible.has(slug))
      .map(({ slug, score }) => ({
        slug, title: title(pages, slug), reason: 'frontier' as const,
        detail: `near your known region (score ${score.toFixed(2)})`,
      }));
  }
  return candidates
    .sort((a, b) => a.meta.difficulty - b.meta.difficulty)
    .slice(0, k)
    .map((p) => ({
      slug: p.slug, title: p.meta.title, reason: 'frontier' as const,
      detail: `easiest unexplored (difficulty ${p.meta.difficulty})`,
    }));
}

export function nextLessons(
  state: StudentState, pages: Map<string, Page>, index: EmbeddingIndex | null,
  now: Date, goal?: string, k = 3
): LessonSuggestion[] {
  const combined = [
    ...reviewDue(state, pages, now).slice(0, 2),
    ...(goal ? unmetPrereqs(goal, pages, state, now) : frontier(state, pages, index, now, k)),
  ];
  const seen = new Set<string>();
  return combined.filter((s) => !seen.has(s.slug) && seen.add(s.slug)).slice(0, k);
}

export function analogies(
  slug: string, state: StudentState, pages: Map<string, Page>,
  index: EmbeddingIndex | null, now: Date, k = 3
): { slug: string; title: string; score: number }[] {
  if (!index) return [];
  const known = new Set(knownSlugs(state, pages, now));
  return index
    .similarTo(slug, k, (s) => known.has(s))
    .map(({ slug: s, score }) => ({ slug: s, title: title(pages, s), score }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queries.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/queries/queries.ts tests/queries.test.ts
git commit -m "feat: teaching queries — review-due, frontier, prereq gaps, analogies"
```

---

### Task 9: Server context + graph tools (search, read_page, write_page, link_pages, unlink_pages)

**Files:**
- Create: `src/server/context.ts`, `src/server/graphTools.ts`
- Test: `tests/graphTools.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-8
- Produces (`context.ts`):
  - `class Ctx` — `constructor(root: string, provider: EmbeddingProvider | null)`; fields `store: VaultStore`; methods:
    - `async snapshot(): Promise<{ pages: Map<string, Page>; edges: Edge[]; index: EmbeddingIndex | null }>` — reloads pages + edges every call; lazily syncs index; if provider is null or `sync` throws, `index` is `null` and `embeddingsError: string | undefined` field is set on the returned object
  - `json(x: unknown)` helper returning `{ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] }`
- Produces (`graphTools.ts`): `registerGraphTools(server: McpServer, ctx: Ctx): void` registering:
  - `search { query: string }` → top 8 of lexical scoring (per query token, case-insensitive: +3 title match, +2 tag match, +1 body match) merged with semantic `similarToMany` results (score added); returns `[{ slug, title, status, score }]`
  - `read_page { slug: string }` → `{ page: { slug, domain, meta, body, warnings }, edges: { out: [{ dst, type, rationale? }], in: [{ src, type, rationale? }] } }` (rationales from `store.readRationales()` by key `` `${src}->${dst}:${type}` ``); error text `page not found: <slug>` with `isError: true` otherwise
  - `write_page { slug, title, body, domain?, prereqs?, deepens?, tags?, difficulty?, status?, sources? }` → writes page (existing page: provided fields override, missing fields keep old values); then `{ page: {...}, proposedLinks: LinkCandidate[], instructions: VERIFY_CONTRACT, graphWarnings: string[] }`
  - `link_pages { src, dst, type: 'prereq'|'deepens'|'related', rationale: string }` — src must exist (error otherwise); dst missing ⇒ `createStub(dst)` and note in response; `prereq` cycle check via `wouldCreateCycle` ⇒ error `rejected: would create prereq cycle`; `prereq`/`deepens` ⇒ add slug to frontmatter array and rewrite page; `related` ⇒ append `\n- [[${dst}]] — ${rationale}` under a `## Links` heading (create heading at body end if absent); saves rationale + appends review-log line `- <yyyy-mm-dd> [<type>] <src> -> <dst> — <rationale>` (date = today); response `{ linked: {src,dst,type}, stubCreated: boolean }`
  - `unlink_pages { src, dst, type }` — `prereq`/`deepens`: remove from frontmatter, rewrite; `related`: error text `related links live in prose — edit the body via write_page`; response `{ unlinked: true }`

- [ ] **Step 1: Write the failing test**

`tests/graphTools.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ctx } from '../src/server/context.js';
import { registerGraphTools } from '../src/server/graphTools.js';
import { FakeProvider } from '../src/embeddings/provider.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-srv-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'chain-rule.md'),
    '---\ntitle: Chain Rule\nstatus: solid\ntags: [calculus]\n---\nderivative of composed functions'
  );
  writeFileSync(
    join(root, 'pages', 'backprop.md'),
    '---\ntitle: Backpropagation\nprereqs: [chain-rule]\n---\ngradients backwards through layers'
  );
  const server = new McpServer({ name: 'engram-test', version: '0.0.0' });
  registerGraphTools(server, new Ctx(root, new FakeProvider()));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});

describe('graph tools', () => {
  it('search ranks title matches first', async () => {
    const { data } = await call('search', { query: 'chain rule' });
    expect(data[0].slug).toBe('chain-rule');
  });

  it('read_page returns page with typed in/out edges', async () => {
    const { data } = await call('read_page', { slug: 'chain-rule' });
    expect(data.page.meta.title).toBe('Chain Rule');
    expect(data.edges.in).toContainEqual(expect.objectContaining({ src: 'backprop', type: 'prereq' }));
  });

  it('read_page errors on unknown slug', async () => {
    const { isError, text } = await call('read_page', { slug: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('page not found');
  });

  it('write_page creates a page and proposes links with contract', async () => {
    const { data } = await call('write_page', {
      slug: 'gradient-descent', title: 'Gradient Descent',
      body: 'step along gradients of composed functions', difficulty: 2,
    });
    expect(data.page.slug).toBe('gradient-descent');
    expect(data.instructions).toContain('rationale');
    expect(Array.isArray(data.proposedLinks)).toBe(true);
  });

  it('link_pages adds a prereq, creates stubs, rejects cycles', async () => {
    const stub = await call('link_pages', {
      src: 'chain-rule', dst: 'derivatives', type: 'prereq', rationale: 'composition needs basic derivatives',
    });
    expect(stub.data.stubCreated).toBe(true);
    const cyc = await call('link_pages', {
      src: 'chain-rule', dst: 'backprop', type: 'prereq', rationale: 'nope',
    });
    expect(cyc.isError).toBe(true);
    expect(cyc.text).toContain('cycle');
    const page = await call('read_page', { slug: 'chain-rule' });
    const out = page.data.edges.out;
    expect(out).toContainEqual(expect.objectContaining({ dst: 'derivatives', type: 'prereq', rationale: 'composition needs basic derivatives' }));
  });

  it('unlink_pages removes frontmatter edges but refuses related', async () => {
    await call('unlink_pages', { src: 'backprop', dst: 'chain-rule', type: 'prereq' });
    const page = await call('read_page', { slug: 'backprop' });
    expect(page.data.edges.out.filter((e: any) => e.type === 'prereq')).toHaveLength(0);
    const rel = await call('unlink_pages', { src: 'backprop', dst: 'x', type: 'related' });
    expect(rel.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graphTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/context.ts`**

```ts
import { join } from 'node:path';
import { VaultStore } from '../vault/vaultStore.js';
import { buildEdges } from '../graph/graph.js';
import { EmbeddingIndex } from '../embeddings/index.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Edge, Page } from '../types.js';

export interface Snapshot {
  pages: Map<string, Page>;
  edges: Edge[];
  index: EmbeddingIndex | null;
  embeddingsError?: string;
}

export class Ctx {
  store: VaultStore;

  constructor(readonly root: string, private provider: EmbeddingProvider | null) {
    this.store = new VaultStore(root);
  }

  async snapshot(): Promise<Snapshot> {
    const pages = this.store.loadPages();
    const edges = buildEdges(pages);
    if (!this.provider) return { pages, edges, index: null, embeddingsError: 'embeddings disabled' };
    try {
      const index = new EmbeddingIndex(join(this.root, '.index'), this.provider);
      await index.sync(pages);
      return { pages, edges, index };
    } catch (e) {
      return { pages, edges, index: null, embeddingsError: (e as Error).message };
    }
  }
}

export function json(x: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(x, null, 2) }] };
}

export function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
```

- [ ] **Step 4: Implement `src/server/graphTools.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Ctx, json, err } from './context.js';
import { proposeLinks, VERIFY_CONTRACT } from '../linking/propose.js';
import { wouldCreateCycle, graphWarnings } from '../graph/graph.js';
import type { LinkType, PageMeta } from '../types.js';

const LINK_TYPES = ['prereq', 'deepens', 'related'] as const;

export function registerGraphTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'search',
    {
      description: 'Search vault pages lexically and semantically. Returns top matches.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const { pages, index } = await ctx.snapshot();
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scores = new Map<string, number>();
      for (const p of pages.values()) {
        let s = 0;
        const t = p.meta.title.toLowerCase();
        const body = p.body.toLowerCase();
        for (const tok of tokens) {
          if (t.includes(tok)) s += 3;
          if (p.meta.tags.some((tag) => tag.includes(tok))) s += 2;
          if (body.includes(tok)) s += 1;
        }
        if (s > 0) scores.set(p.slug, s);
      }
      if (index) {
        // seed semantic scores from lexical hits (or all pages if none)
        const seeds = scores.size ? [...scores.keys()] : [...pages.keys()].slice(0, 1);
        for (const { slug, score } of index.similarToMany(seeds, 8)) {
          scores.set(slug, (scores.get(slug) ?? 0) + score);
        }
      }
      const out = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([slug, score]) => {
          const p = pages.get(slug)!;
          return { slug, title: p.meta.title, status: p.meta.status, score: +score.toFixed(2) };
        });
      return json(out);
    }
  );

  server.registerTool(
    'read_page',
    {
      description: 'Read a page: content, metadata, and typed in/out edges with rationales.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const { pages, edges } = await ctx.snapshot();
      const page = pages.get(slug);
      if (!page) return err(`page not found: ${slug}`);
      const rationales = ctx.store.readRationales();
      const withR = (src: string, dst: string, type: LinkType) => rationales[`${src}->${dst}:${type}`];
      return json({
        page: { slug: page.slug, domain: page.domain, meta: page.meta, body: page.body, warnings: page.warnings },
        edges: {
          out: edges.filter((e) => e.src === slug).map((e) => ({ dst: e.dst, type: e.type, rationale: withR(e.src, e.dst, e.type) })),
          in: edges.filter((e) => e.dst === slug).map((e) => ({ src: e.src, type: e.type, rationale: withR(e.src, e.dst, e.type) })),
        },
      });
    }
  );

  server.registerTool(
    'write_page',
    {
      description:
        'Create or update a page. Returns proposed link candidates you MUST verify per the returned instructions.',
      inputSchema: {
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        domain: z.string().optional(),
        prereqs: z.array(z.string()).optional(),
        deepens: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        difficulty: z.number().min(1).max(5).optional(),
        status: z.enum(['stub', 'draft', 'solid']).optional(),
        sources: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const { pages } = await ctx.snapshot();
      const old = pages.get(args.slug);
      const meta: PageMeta = {
        title: args.title,
        prereqs: args.prereqs ?? old?.meta.prereqs ?? [],
        deepens: args.deepens ?? old?.meta.deepens ?? [],
        tags: args.tags ?? old?.meta.tags ?? [],
        difficulty: args.difficulty ?? old?.meta.difficulty ?? 3,
        status: args.status ?? (old && old.meta.status !== 'stub' ? old.meta.status : 'draft'),
        sources: args.sources ?? old?.meta.sources ?? [],
      };
      ctx.store.writePage(args.slug, meta, args.body, args.domain ?? old?.domain ?? '');
      const snap = await ctx.snapshot();
      const page = snap.pages.get(args.slug)!;
      return json({
        page: { slug: page.slug, domain: page.domain, meta: page.meta, warnings: page.warnings },
        proposedLinks: proposeLinks(page, snap.pages, snap.edges, snap.index),
        instructions: VERIFY_CONTRACT,
        graphWarnings: graphWarnings(snap.pages, snap.edges).slice(0, 10),
      });
    }
  );

  server.registerTool(
    'link_pages',
    {
      description:
        'Add a verified typed link src->dst with a one-line rationale naming what breaks/enriches without it.',
      inputSchema: {
        src: z.string(),
        dst: z.string(),
        type: z.enum(LINK_TYPES),
        rationale: z.string().min(10),
      },
    },
    async ({ src, dst, type, rationale }) => {
      const { pages, edges } = await ctx.snapshot();
      const srcPage = pages.get(src);
      if (!srcPage) return err(`page not found: ${src}`);
      let stubCreated = false;
      if (!pages.has(dst)) {
        ctx.store.createStub(dst);
        stubCreated = true;
      }
      if (type === 'prereq' && wouldCreateCycle(edges, src, dst)) {
        return err(`rejected: would create prereq cycle ${src} -> ${dst}`);
      }
      if (type === 'related') {
        const line = `- [[${dst}]] — ${rationale}`;
        const body = srcPage.body.includes('## Links')
          ? srcPage.body.replace('## Links', `## Links\n${line}`)
          : `${srcPage.body.trimEnd()}\n\n## Links\n${line}\n`;
        ctx.store.writePage(src, srcPage.meta, body, srcPage.domain);
      } else {
        const list = type === 'prereq' ? srcPage.meta.prereqs : srcPage.meta.deepens;
        if (!list.includes(dst)) list.push(dst);
        ctx.store.writePage(src, srcPage.meta, srcPage.body, srcPage.domain);
      }
      const today = new Date().toISOString().slice(0, 10);
      ctx.store.appendReviewLog(`- ${today} [${type}] ${src} -> ${dst} — ${rationale}`);
      ctx.store.saveRationale(`${src}->${dst}:${type}`, rationale);
      return json({ linked: { src, dst, type }, stubCreated });
    }
  );

  server.registerTool(
    'unlink_pages',
    {
      description: 'Remove a prereq/deepens edge. Related links live in prose; edit via write_page.',
      inputSchema: { src: z.string(), dst: z.string(), type: z.enum(LINK_TYPES) },
    },
    async ({ src, dst, type }) => {
      if (type === 'related') return err('related links live in prose — edit the body via write_page');
      const { pages } = await ctx.snapshot();
      const page = pages.get(src);
      if (!page) return err(`page not found: ${src}`);
      const list = type === 'prereq' ? page.meta.prereqs : page.meta.deepens;
      const i = list.indexOf(dst);
      if (i >= 0) list.splice(i, 1);
      ctx.store.writePage(src, page.meta, page.body, page.domain);
      return json({ unlinked: true });
    }
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/graphTools.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/context.ts src/server/graphTools.ts tests/graphTools.test.ts
git commit -m "feat: MCP graph tools — search, read/write page, verified linking"
```

---

### Task 10: Compile, path, and student tools + server entrypoint

**Files:**
- Create: `src/server/teachTools.ts`, `src/server.ts`
- Test: `tests/teachTools.test.ts`

**Interfaces:**
- Consumes: Tasks 3-9 (`Ctx`, `json`, `err` from `./server/context.js`; queries; student model)
- Produces (`teachTools.ts`): `registerTeachTools(server: McpServer, ctx: Ctx): void` registering:
  - `compile_source { file: string }` → `{ source: string, existingPages: [{slug,title}], instructions: COMPILE_CONTRACT }`; error if file not in `listRaw()`. `COMPILE_CONTRACT` (export const): `Extract 3-10 atomic concepts from this source. For each concept call write_page: kebab-case slug, clear title, a self-contained explanatory body using [[wiki-links]] to other concepts, difficulty 1-5, status "draft", sources ["raw/<file>"]. Prefer linking to existingPages over creating near-duplicates. Then verify each returned proposedLinks candidate per its instructions.`
  - `list_paths {}` → `store.listPathDocs()`
  - `read_path { slug }` → path doc or error `path not found: <slug>`
  - `create_path { slug, title, pages: string[], narrative: string }` — every slug in `pages` must exist as a page (error listing missing ones); writes path doc; returns `{ created: slug }`
  - `get_student_state { student: string }` → `{ [slug]: { level, effective, last_reinforced, misconceptions, evidenceCount } }` (only slugs in state)
  - `record_evidence { student, slug, kind: enum, note, misconception? }` — slug must exist as page (error otherwise); `applyEvidence` with `new Date()`; persists; returns `{ slug, level, effective }`
  - `next_lessons { student, goal?, k? }` → `LessonSuggestion[]` (uses snapshot index; goal must exist if given); response includes `embeddingsError` if index unavailable
  - `find_analogies { student, slug, k? }` → analogies list; error if slug missing; `{ analogies: [], note: embeddingsError }` when no index
- Produces (`server.ts`): entrypoint — reads `LOREWEAVER_VAULT` (exit 1 with stderr message if unset), `getProvider()`, creates `McpServer { name: 'engram', version: '0.1.0' }`, registers both tool groups, connects `StdioServerTransport`.

- [ ] **Step 1: Write the failing test**

`tests/teachTools.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ctx } from '../src/server/context.js';
import { registerGraphTools } from '../src/server/graphTools.js';
import { registerTeachTools } from '../src/server/teachTools.js';
import { FakeProvider } from '../src/embeddings/provider.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-teach-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'raw'), { recursive: true });
  writeFileSync(join(root, 'pages', 'derivatives.md'), '---\ntitle: Derivatives\ndifficulty: 1\n---\nrates of change');
  writeFileSync(join(root, 'pages', 'chain-rule.md'), '---\ntitle: Chain Rule\nprereqs: [derivatives]\ndifficulty: 2\n---\ncomposed derivatives');
  writeFileSync(join(root, 'raw', 'lecture.md'), 'Today we cover the chain rule and gradients.');
  const server = new McpServer({ name: 'engram-test', version: '0.0.0' });
  const ctx = new Ctx(root, new FakeProvider());
  registerGraphTools(server, ctx);
  registerTeachTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});

describe('teach tools', () => {
  it('compile_source returns source + contract, errors on missing file', async () => {
    const { data } = await call('compile_source', { file: 'lecture.md' });
    expect(data.source).toContain('chain rule');
    expect(data.instructions).toContain('write_page');
    expect(data.existingPages.map((p: any) => p.slug)).toContain('chain-rule');
    expect((await call('compile_source', { file: 'nope.md' })).isError).toBe(true);
  });

  it('paths: create validates page existence, then read/list', async () => {
    const bad = await call('create_path', { slug: 'p', title: 'P', pages: ['nope'], narrative: 'x' });
    expect(bad.isError).toBe(true);
    await call('create_path', { slug: 'calc', title: 'Calc Trail', pages: ['derivatives', 'chain-rule'], narrative: 'From zero to chain rule.' });
    expect((await call('list_paths', {})).data).toHaveLength(1);
    expect((await call('read_path', { slug: 'calc' })).data.pages).toEqual(['derivatives', 'chain-rule']);
  });

  it('record_evidence updates state; get_student_state reflects it', async () => {
    const rec = await call('record_evidence', {
      student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'nailed limits framing',
    });
    expect(rec.data.level).toBe('exposed'); // unseen -> one above = exposed
    const state = await call('get_student_state', { student: 'sabien' });
    expect(state.data.derivatives.evidenceCount).toBe(1);
    expect((await call('record_evidence', { student: 's', slug: 'nope', kind: 'exposed', note: 'x' })).isError).toBe(true);
  });

  it('next_lessons suggests frontier work for a fresh student', async () => {
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'a' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'b' });
    // derivatives now practicing => chain-rule unlocked
    const { data } = await call('next_lessons', { student: 'sabien' });
    expect(data.map((s: any) => s.slug)).toContain('chain-rule');
  });

  it('find_analogies returns known neighbors', async () => {
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'a' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'b' });
    const { data } = await call('find_analogies', { student: 'sabien', slug: 'chain-rule' });
    expect(data.analogies.map((a: any) => a.slug)).toEqual(['derivatives']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teachTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/teachTools.ts`**

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Ctx, json, err } from './context.js';
import { applyEvidence, effectiveLevel } from '../student/model.js';
import { analogies, nextLessons } from '../queries/queries.js';

export const COMPILE_CONTRACT = `Extract 3-10 atomic concepts from this source. For each concept call write_page:
kebab-case slug, clear title, a self-contained explanatory body using [[wiki-links]] to other concepts,
difficulty 1-5, status "draft", sources ["raw/<file>"]. Prefer linking to existingPages over creating
near-duplicates. Then verify each returned proposedLinks candidate per its instructions.`;

const KINDS = ['exposed', 'explained-correctly', 'applied-correctly', 'struggled', 'misconception'] as const;

export function registerTeachTools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'compile_source',
    {
      description: 'Fetch a raw source plus compile instructions. You do the extraction via write_page calls.',
      inputSchema: { file: z.string() },
    },
    async ({ file }) => {
      if (!ctx.store.listRaw().includes(file)) return err(`raw file not found: ${file}`);
      const { pages } = await ctx.snapshot();
      return json({
        source: ctx.store.readRaw(file),
        existingPages: [...pages.values()].map((p) => ({ slug: p.slug, title: p.meta.title })),
        instructions: COMPILE_CONTRACT.replace('<file>', file),
      });
    }
  );

  server.registerTool(
    'list_paths',
    { description: 'List curated learning paths (rabbit holes).', inputSchema: {} },
    async () => json(ctx.store.listPathDocs())
  );

  server.registerTool(
    'read_path',
    { description: 'Read one curated path: ordered pages + narrative.', inputSchema: { slug: z.string() } },
    async ({ slug }) => {
      const doc = ctx.store.readPathDoc(slug);
      return doc ? json(doc) : err(`path not found: ${slug}`);
    }
  );

  server.registerTool(
    'create_path',
    {
      description: 'Create a curated learning path from existing pages, in teaching order, with narrative.',
      inputSchema: {
        slug: z.string(), title: z.string(), pages: z.array(z.string()).min(1), narrative: z.string(),
      },
    },
    async ({ slug, title, pages: pageSlugs, narrative }) => {
      const { pages } = await ctx.snapshot();
      const missing = pageSlugs.filter((s) => !pages.has(s));
      if (missing.length) return err(`pages not found: ${missing.join(', ')}`);
      ctx.store.writePathDoc(slug, title, pageSlugs, narrative);
      return json({ created: slug });
    }
  );

  server.registerTool(
    'get_student_state',
    { description: "Student's mastery map with decay-adjusted effective levels.", inputSchema: { student: z.string() } },
    async ({ student }) => {
      const state = ctx.store.readStudent(student);
      const now = new Date();
      const out: Record<string, unknown> = {};
      for (const [slug, m] of Object.entries(state)) {
        out[slug] = {
          level: m.level,
          effective: effectiveLevel(m, now),
          last_reinforced: m.last_reinforced,
          misconceptions: m.misconceptions,
          evidenceCount: m.evidence.length,
        };
      }
      return json(out);
    }
  );

  server.registerTool(
    'record_evidence',
    {
      description:
        'Record graded evidence about a student on a page. Mastery only changes through this tool.',
      inputSchema: {
        student: z.string(), slug: z.string(), kind: z.enum(KINDS), note: z.string(),
        misconception: z.string().optional(),
      },
    },
    async ({ student, slug, kind, note, misconception }) => {
      const { pages } = await ctx.snapshot();
      if (!pages.has(slug)) return err(`page not found: ${slug}`);
      const now = new Date();
      const next = applyEvidence(ctx.store.readStudent(student), slug, kind, note, now, misconception);
      ctx.store.writeStudent(student, next);
      return json({ slug, level: next[slug].level, effective: effectiveLevel(next[slug], now) });
    }
  );

  server.registerTool(
    'next_lessons',
    {
      description:
        'Ranked next topics with reasons (review-due / unmet-prereq / frontier). Call at session start.',
      inputSchema: { student: z.string(), goal: z.string().optional(), k: z.number().optional() },
    },
    async ({ student, goal, k }) => {
      const snap = await ctx.snapshot();
      if (goal && !snap.pages.has(goal)) return err(`page not found: ${goal}`);
      const out = nextLessons(
        ctx.store.readStudent(student), snap.pages, snap.index, new Date(), goal, k ?? 3
      );
      return json(snap.embeddingsError ? { lessons: out, note: snap.embeddingsError } : out);
    }
  );

  server.registerTool(
    'find_analogies',
    {
      description: "Bridge a new topic to the student's known pages (cross-domain analogies).",
      inputSchema: { student: z.string(), slug: z.string(), k: z.number().optional() },
    },
    async ({ student, slug, k }) => {
      const snap = await ctx.snapshot();
      if (!snap.pages.has(slug)) return err(`page not found: ${slug}`);
      const out = analogies(
        slug, ctx.store.readStudent(student), snap.pages, snap.index, new Date(), k ?? 3
      );
      return json({ analogies: out, ...(snap.embeddingsError ? { note: snap.embeddingsError } : {}) });
    }
  );
}
```

- [ ] **Step 4: Implement `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Ctx } from './server/context.js';
import { registerGraphTools } from './server/graphTools.js';
import { registerTeachTools } from './server/teachTools.js';
import { getProvider } from './embeddings/provider.js';

const root = process.env.LOREWEAVER_VAULT;
if (!root) {
  console.error('LOREWEAVER_VAULT env var must point to the vault directory');
  process.exit(1);
}

const server = new McpServer({ name: 'engram', version: '0.1.0' });
const ctx = new Ctx(root, getProvider());
registerGraphTools(server, ctx);
registerTeachTools(server, ctx);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/teachTools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/teachTools.ts src/server.ts tests/teachTools.test.ts
git commit -m "feat: teaching tools (compile, paths, student model) and stdio entrypoint"
```

---

### Task 11: stdio integration test + README + tutor prompt

**Files:**
- Create: `tests/integration.test.ts`, `README.md`, `docs/tutor-prompt.md`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: the finished server (`src/server.ts`) via a real child process over stdio
- Produces: nothing downstream — this is the end-to-end gate

- [ ] **Step 1: Write the integration test**

`tests/integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-e2e-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'derivatives.md'), '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve('src/server.ts')],
      env: {
        ...process.env as Record<string, string>,
        LOREWEAVER_VAULT: root,
        LOREWEAVER_EMBEDDINGS: 'fake',
      },
    })
  );
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe('engram over stdio', () => {
  it('lists all 13 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'compile_source', 'create_path', 'find_analogies', 'get_student_state',
      'link_pages', 'list_paths', 'next_lessons', 'read_page', 'read_path',
      'record_evidence', 'search', 'unlink_pages', 'write_page',
    ]);
  });

  it('teaching loop: write, link, evidence, next_lessons', async () => {
    const wp = await call('write_page', {
      slug: 'chain-rule', title: 'Chain Rule', body: 'composed derivatives, rates of change',
      difficulty: 2,
    });
    expect(wp.data.instructions).toContain('rationale');

    const lp = await call('link_pages', {
      src: 'chain-rule', dst: 'derivatives', type: 'prereq',
      rationale: 'composition derivative needs single-function derivatives first',
    });
    expect(lp.data.linked.type).toBe('prereq');

    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'solid' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'solid' });

    const nl = await call('next_lessons', { student: 'sabien' });
    expect(nl.data.map((s: any) => s.slug)).toContain('chain-rule');
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify it fails or passes honestly**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS if Tasks 1-10 are correct — this test is the gate, not new code. If it FAILS, fix the revealed defect in the responsible module (with a unit test there) before proceeding.

- [ ] **Step 3: Write `docs/tutor-prompt.md`**

```markdown
# Engram Tutor Prompt

System prompt / skill text for any agent connected to the engram MCP server.

---

You are a personal tutor backed by the Engram teaching-memory server.
The vault is the curriculum; the student model is your memory of the learner. Rules:

1. **Open every session** with `next_lessons { student }` (add `goal` if the student named one).
   Tell the student WHY each suggestion: review-due, unmet prerequisite, or frontier.
2. **Probe before telling.** Ask the student to explain or apply the concept first.
   Grade every substantive exchange with `record_evidence`:
   - explained/applied correctly → those kinds; struggled → `struggled`;
   - wrong mental model → `misconception` with the misconception verbatim.
   Never mark mastery without evidence from THIS conversation.
3. **Bridge every new concept**: call `find_analogies` and open with the closest known page
   ("you already know X — this works the same way, except…").
4. **Offer rabbit holes**: when the student shows appetite, offer the page's `deepens` links
   or a curated path (`list_paths`).
5. **Re-probe recorded misconceptions** from `get_student_state` at the next natural moment.
6. **Grow the vault**: hitting a stub page mid-lesson? Write it on the spot (`write_page`),
   verify its proposed links per the returned instructions, keep teaching.
7. When compiling sources (`compile_source`), follow the returned contract exactly.
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Engram

Teaching-memory MCP server: an Obsidian-compatible markdown vault of linked concept
pages, curated learning paths ("rabbit holes"), and a persistent evidence-graded
student model — so any MCP agent can tutor with durable memory of both the subject
and the student.

## Quick start

```bash
npm install
LOREWEAVER_VAULT=/path/to/vault npm start
```

Vault layout (created on demand):

```
vault/
  pages/<domain>/<slug>.md   # one concept per file; [[wiki-links]] + typed frontmatter edges
  paths/<slug>.md            # curated rabbit holes (ordered pages + narrative)
  students/<name>.json       # evidence-graded mastery with read-time decay
  raw/                       # sources awaiting compilation
  review-log.md              # every accepted link with its rationale
```

## Claude Code config (`.mcp.json`)

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/engram/src/server.ts"],
      "env": { "LOREWEAVER_VAULT": "/absolute/path/to/vault" }
    }
  }
}
```

## Embeddings

`LOREWEAVER_EMBEDDINGS` = `ollama` (default; needs `ollama pull nomic-embed-text`),
`fake` (deterministic, for tests), `none` (lexical-only degradation).

## Teaching

Give your agent `docs/tutor-prompt.md` as its system prompt / skill.
Design spec: `docs/superpowers/specs/2026-07-10-engram-design.md`.

## Tests

```bash
npm test
```
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all test files pass (types, parsePage, vaultStore, graph, embeddings, propose, student, queries, graphTools, teachTools, integration).

- [ ] **Step 6: Commit**

```bash
git add tests/integration.test.ts README.md docs/tutor-prompt.md
git commit -m "feat: stdio integration test, README, tutor prompt"
```

---

## Self-review notes

- Spec coverage: vault format (T2-T3), linking pipeline propose/validate + review log + rationales (T4, T6, T9), verify gate as agent-side contract (T6 — adaptation documented in Architecture), embedding index with three uses (T5, T6, T8), student model with decay + evidence + misconceptions (T7), 13 MCP tools (T9-T10), two content flows (T9 `write_page`, T10 `compile_source`), tutor behavior (T11 prompt doc), error handling: malformed frontmatter (T2), embeddings degradation (T5 `getProvider`/`none`, T9 `Ctx.snapshot` catch, T8 lexical fallbacks), stdio integration test (T11).
- Deliverable 2 of the spec (`fable-plan-sonnet-execute` skill) already shipped separately at `~/.claude/skills/fable-plan-sonnet-execute/SKILL.md` — not a task here.
- Out of scope (per spec): UI, remote transport, quiz tooling, multi-user auth.
