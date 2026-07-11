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
