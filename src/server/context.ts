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
  private index: EmbeddingIndex | null = null;

  constructor(readonly root: string, private provider: EmbeddingProvider | null) {
    this.store = new VaultStore(root);
  }

  async snapshot(): Promise<Snapshot> {
    const pages = this.store.loadPages();
    const edges = buildEdges(pages);
    if (!this.provider) return { pages, edges, index: null, embeddingsError: 'embeddings disabled' };
    try {
      // One index per Ctx, not per snapshot: a fresh instance each call would re-read the file and
      // never see an in-flight background sync, so every snapshot would start another pass over
      // the same stale pages.
      this.index ??= new EmbeddingIndex(join(this.root, '.index'), this.provider);
      // Deliberately NOT awaited. Search is lexical-first and the index only AUGMENTS it, so
      // waiting bought nothing — and cost a freshly compiled 273-page vault over five minutes on
      // its first question, which reads as a hung tutor. The index serves what it already has and
      // catches up behind the turn.
      this.index.startSync(pages);
      return { pages, edges, index: this.index };
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
