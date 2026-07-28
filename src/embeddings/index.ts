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
    this.data = this.loadOrReset();
  }

  /**
   * Read the cache, or reset to empty when it can't be trusted. This is a derived, losslessly
   * rebuildable cache — sync() recomputes every vector from the pages — so "reset" costs one
   * re-embed, never data. Three ways it can't be trusted:
   *   - a different provider wrote it (model swap): the vectors aren't comparable.
   *   - it's corrupt: writeFileSync (sync, below) is not atomic, so a crash or disk-full mid-write
   *     truncates the file. A bare JSON.parse here threw straight out of the constructor, which
   *     snapshot() catches by degrading to lexical-only search — but because the throw beat sync()'s
   *     rewrite, the corrupt file was never repaired and semantic search stayed dead every session
   *     after, until someone deleted the file by hand. Degrading to empty lets the next sync heal it.
   *   - it parsed but lost its shape (a hand-edit, a partial legacy file): a missing `entries` would
   *     throw later in sync()/similarToMany instead, so reject it here too.
   */
  private loadOrReset(): Stored {
    const fresh: Stored = { provider: this.provider.name, entries: {} };
    if (!existsSync(this.file)) return fresh;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
      if (parsed?.provider !== this.provider.name) return fresh;
      if (!parsed.entries || typeof parsed.entries !== 'object') return fresh;
      return parsed;
    } catch {
      return fresh;
    }
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
