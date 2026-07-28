import type { Edge, LinkCandidate, Page } from '../types.js';
import type { EmbeddingIndex } from '../embeddings/index.js';

export const VERIFY_CONTRACT = `You are the verify gate for proposed links. Judge each candidate INDEPENDENTLY:
Does a specific claim in the source page fail, or get materially enriched, without the target page?
- Accept ONLY if you can state a one-line rationale naming that specific dependency or enrichment.
- Pick the type: "prereq" (source cannot be understood without target — teaching order),
  "deepens" (optional depth / rabbit hole), "related" (lateral analogy or contrast).
- For each ACCEPTED candidate call the link_pages tool: { src, dst, type, rationale }.
- Silently drop candidates you cannot justify. Do not link for mere topical overlap.`;

/**
 * Whole-word (or whole-phrase) mention of `title` in `body`, not a raw substring. Substring matching
 * floods the verify gate the same way an empty title does — from the OTHER end: a page titled "set"
 * would match every body containing "subset" or "settings", and "function" would match "functional",
 * "functions", "dysfunction". Requiring the title to sit on word boundaries kills that whole class.
 *
 * Title metacharacters are escaped, because titles carry them (C++, f(x), √d_k). The `\W` flanks
 * (rather than `\b`) are deliberate: `\b` misbehaves against a title that begins or ends with a
 * non-word character, which those examples do.
 *
 * The accepted cost is recall: an exact plural no longer matches ("cat" misses "cats"). For a
 * SUGGESTION gate the learner verifies, precision beats recall — a flood is worse than a missed
 * hint — and semantic linking still carries the conceptual tie regardless of surface form.
 */
function mentions(body: string, title: string): boolean {
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${esc}(?:\\W|$)`).test(body);
}

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
  const myTitle = page.meta.title.toLowerCase().trim();
  for (const other of pages.values()) {
    if (!eligible(other.slug)) continue;
    const otherTitle = other.meta.title.toLowerCase().trim();
    // includes('') is always true — an explicitly empty frontmatter title (which the vault loader
    // passes through: it only checks typeof) would lexically match EVERY page in both directions
    // and flood the verify gate with the whole vault. No title, no lexical signal.
    if (!otherTitle || !myTitle) continue;
    if (mentions(myBody, otherTitle) || mentions(other.body.toLowerCase(), myTitle)) {
      offer({ src: page.slug, dst: other.slug, score: 0.5, via: 'lexical' });
    }
  }

  return [...byDst.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}
