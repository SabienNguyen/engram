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

// Best-effort strip of a frontmatter block when the YAML itself failed to
// parse. We only look for the literal `---` delimiters; if there's no
// closing delimiter we can't tell where the body starts, so return raw as-is.
function stripFrontmatterBestEffort(raw: string): string {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return raw;
  const lines = raw.split(/\r\n|\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return lines.slice(i + 1).join('\n');
    }
  }
  return raw;
}

// sources are file paths, not slugs — do not slugify them.
function sourcesArray(v: unknown, warnings: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  warnings.push('invalid sources: expected string array');
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
    body = stripFrontmatterBestEffort(raw);
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
  return matter.stringify(body, meta as unknown as Record<string, unknown>);
}
