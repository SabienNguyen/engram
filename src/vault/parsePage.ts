import matter from 'gray-matter';
import type { Page, PageMeta, PageStatus } from '../types.js';

const WIKI_LINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

// gray-matter caches the file object keyed by the whole input string, and it writes that entry
// BEFORE parsing — so a page whose YAML throws leaves a half-built object in the cache, and the
// next matter() call on the same bytes returns it as a clean parse: no error, empty data, and the
// frontmatter still sitting in `content`. A second loadPages() of a broken page therefore dropped
// its warning and served the delimiters as body text. Any non-undefined options value skips the
// cache entirely (see gray-matter/index.js), which is the only way off it.
const NO_CACHE = {};
const STATUSES: PageStatus[] = ['stub', 'draft', 'solid'];

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// A single YAML-coerced element (`prereqs: [chain-rule, 2024]` reads that bare year as a number)
// used to void the WHOLE list — the next write persisted `[]` and silently dropped every valid
// entry with it. Keep what parses as a string, warn about what doesn't, drop only that element.
function strArray(v: unknown, field: string, warnings: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warnings.push(`invalid ${field}: expected string array`);
    return [];
  }
  const valid: string[] = [];
  const bad: unknown[] = [];
  for (const x of v) {
    if (typeof x === 'string') valid.push(slugify(x));
    else bad.push(x);
  }
  if (bad.length > 0) {
    warnings.push(`invalid ${field}: dropped ${bad.length} non-string element(s): ${bad.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  return valid;
}

const KNOWN_META_KEYS = new Set([
  'title', 'prereqs', 'deepens', 'tags', 'difficulty', 'status', 'sources', 'authors',
]);

// Everything in frontmatter this engram doesn't model — see PageMeta.extra. `undefined` (not
// `{}`) when there's nothing extra, so a page with no extra keys serializes byte-for-byte as
// before this existed.
function extraFields(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_META_KEYS.has(k)) extra[k] = v;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

// Best-effort split of a frontmatter block when the YAML itself failed to parse — gray-matter
// can't tell us where the block ended, so we look for the literal `---` delimiters. Slices rather
// than splits on lines so the block's text comes back byte-for-byte (writePage writes it back).
// undefined when there's no opening delimiter, or no closing one: without a closing `---` we can't
// tell where the body starts.
function splitFrontmatterBestEffort(raw: string): { frontmatter: string; body: string } | undefined {
  const open = /^---\r?\n/.exec(raw);
  if (!open) return undefined;
  const rest = raw.slice(open[0].length);
  const close = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(rest);
  if (!close) return undefined;
  return {
    frontmatter: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

/** The verbatim text of a frontmatter block that is PRESENT but does not parse as YAML (delimiters
 *  excluded); undefined when there is no block or the block parses fine. A page whose YAML fails
 *  reads back with EMPTY meta — parsePage degrades rather than throwing, so one hand-edited page
 *  can't break every read of the vault — and serializing that empty meta erased the learner's
 *  frontmatter on the next write. vaultStore.writePage writes this back instead. Only the yes/no
 *  matters here; the parser's message is already on the page's `warnings`. */
export function unparsedFrontmatter(raw: string): string | undefined {
  const split = splitFrontmatterBestEffort(raw);
  if (!split) return undefined;
  try {
    matter(raw, NO_CACHE);
    return undefined;
  } catch {
    return split.frontmatter;
  }
}

// sources are file paths, not slugs — do not slugify them. Same for authors: a person's name is
// not an identifier, and "Grant Sanderson" must not come back as "grant-sanderson".
function sourcesArray(v: unknown, warnings: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  warnings.push('invalid sources: expected string array');
  return [];
}

function authorsArray(v: unknown, warnings: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  // A single name unbracketed in frontmatter (`authors: Grant Sanderson`) is the obvious hand-edit
  // and means exactly one author — read it rather than warning a human's own note into a warning.
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  warnings.push('invalid authors: expected string array');
  return [];
}

export function parsePage(slug: string, domain: string, raw: string): Page {
  const warnings: string[] = [];
  let data: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw, NO_CACHE);
    data = (parsed.data as Record<string, unknown>) ?? {};
    body = parsed.content;
  } catch (e) {
    warnings.push(`frontmatter parse error: ${(e as Error).message}`);
    body = splitFrontmatterBestEffort(raw)?.body ?? raw;
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
    sources: sourcesArray(data.sources, warnings),
    authors: authorsArray(data.authors, warnings),
    extra: extraFields(data),
  };
  if (warnings.length > 0 && meta.status === 'solid') meta.status = 'draft';

  // Extract wiki-links from a code-stripped copy of the body: a `[[note]]` shown inside a fenced
  // block or an inline-code span is the syntax AS CONTENT (a page teaching wiki/Obsidian markup),
  // not a real link — counting it minted a phantom 'related' edge and a "no page yet" mention to a
  // page that never existed. `body` itself is returned untouched; only the link scan skips code.
  // (inlineLinks uses the captured slug, never a match index, so a non-length-preserving strip is
  // fine here.) Unlike the chat renderer's \[…\] case, `[[…]]` has no competing meaning in code.
  const linkScanBody = body
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '');
  const inlineLinks = [...new Set([...linkScanBody.matchAll(WIKI_LINK)].map((m) => slugify(m[1])))];
  return { slug, domain, meta, body, inlineLinks, warnings };
}

export function serializePage(meta: PageMeta, body: string): string {
  // `extra` isn't a real frontmatter key — it's a bag of the ones we don't model (see
  // PageMeta.extra). Write those back alongside the known fields instead of losing them; spread
  // order puts `extra` first so a same-named known field (there shouldn't be one, since
  // extraFields excludes KNOWN_META_KEYS) always wins.
  const { extra, ...known } = meta;
  return matter.stringify(body, { ...extra, ...known } as Record<string, unknown>);
}
