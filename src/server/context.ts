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
