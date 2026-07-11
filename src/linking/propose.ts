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
