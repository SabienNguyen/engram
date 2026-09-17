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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string, private provider: EmbeddingProvider | null,
    /** How long write_page waits for its own page to embed before proposing links without it. */
    private freshPageTimeoutMs = 10_000,
  ) {
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
      // The error, if any, is from the LAST *completed* attempt — this call's own startSync is
      // still running. A provider outage used to die inside startSync's .catch with only a
      // console.error, so search/find_analogies had no way to tell a learner semantic ranking was
      // skipped; now the next snapshot after a failed sync carries it forward until a sync succeeds.
      const embeddingsError = this.index.lastSyncError();
      return { pages, edges, index: this.index, ...(embeddingsError ? { embeddingsError } : {}) };
    } catch (e) {
      return { pages, edges, index: null, embeddingsError: (e as Error).message };
    }
  }

  /** Like snapshot(), but guarantees `slug` (a page just written) is embedded before returning —
   *  write_page needs its own page's candidates in proposeLinks right now, not whenever the
   *  background sync next gets around to it. See EmbeddingIndex.syncOne. */
  async snapshotWithFreshPage(slug: string): Promise<Snapshot> {
    const snap = await this.snapshot();
    const page = snap.pages.get(slug);
    if (snap.index && page) {
      // Bounded, and called OUTSIDE the write queue (see graphTools' write_page). syncOne waits out
      // the whole-vault background sync and then calls the provider, and the ollama provider's
      // fetch has no timeout: awaited without a bound inside the queue, one stalled embedding call
      // froze every later vault write until restart. The embed keeps running after the deadline —
      // only this caller stops waiting for it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`embedding the new page took over ${this.freshPageTimeoutMs}ms`)),
          this.freshPageTimeoutMs);
      });
      try {
        await Promise.race([snap.index.syncOne(page), deadline]);
      } catch (e) {
        const embeddingsError = (e as Error).message;
        console.error(`[embeddings] ${slug}: no semantic link proposals this call — ${embeddingsError}`);
        return { ...snap, embeddingsError };
      } finally {
        clearTimeout(timer);
      }
    }
    return snap;
  }

  /** Runs `fn` after every previously queued write settles, and queues the next one behind it — a
   *  promise-chain mutex. write_page/link_pages/unlink_pages each read a snapshot, compute from it,
   *  then write — a read-compute-write that spans an `await` — so two handlers interleaving across
   *  that gap can each compute from the same stale snapshot and one write clobbers the other
   *  (myelin's compiler fans out 4+ concurrent write_page calls during a bulk compile). Routing the
   *  WHOLE handler body through this makes the vault a single writer again: whichever handler runs
   *  next always starts from a snapshot taken after the previous one finished writing. A failed `fn`
   *  only rejects its own caller — the queue itself always moves on to the next entry. */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function json(x: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(x, null, 2) }] };
}

export function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
