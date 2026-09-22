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

/**
 * Prereq cycles ALREADY in the vault, walked from each page's own prereq list rather than from
 * Edge[]: buildEdges drops src === dst, so the simplest hand-edit mistake — a page listing itself
 * as its own prereq — produces no edge to find, while frontier() still treats the page as blocked
 * and drops it from the curriculum without a word. wouldCreateCycle only guards edges this server
 * is asked to add; nothing looked at what Obsidian already wrote.
 */
export function prereqCycles(pages: Map<string, Page>): string[] {
  const cycles: string[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();
  const visit = (slug: string) => {
    if (done.has(slug)) return;
    if (onPath.has(slug)) {
      cycles.push(`cycle: ${[...path.slice(path.indexOf(slug)), slug].join(' -> ')}`);
      return;
    }
    onPath.add(slug);
    path.push(slug);
    for (const pre of pages.get(slug)?.meta.prereqs ?? []) visit(pre);
    path.pop();
    onPath.delete(slug);
    done.add(slug);
  };
  // Sorted, so the same vault always reports the same cycle written from the same starting page.
  for (const slug of [...pages.keys()].sort()) visit(slug);
  return cycles;
}

export function graphWarnings(pages: Map<string, Page>, edges: Edge[]): string[] {
  const inbound = new Map<string, number>();
  for (const e of edges) inbound.set(e.dst, (inbound.get(e.dst) ?? 0) + 1);
  // Cycles first: callers cap this list (graphTools slices to 10) and a compile's worth of orphan
  // lines would otherwise bury the one warning whose pages are being deleted from the curriculum.
  const warnings: string[] = prereqCycles(pages);
  for (const slug of pages.keys()) {
    const n = inbound.get(slug) ?? 0;
    if (n === 0) warnings.push(`orphan: ${slug}`);
    if (n >= 20) warnings.push(`hub: ${slug} (${n} inbound)`);
  }
  return warnings;
}
