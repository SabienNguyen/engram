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
