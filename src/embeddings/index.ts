import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
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

  /** Embedding in progress, if any — so overlapping callers coalesce onto one run instead of
   *  each firing a duplicate pass over the same stale pages. */
  private running: Promise<void> | null = null;

  /** The most recent background sync's failure, if the last completed attempt failed — e.g. the
   *  ollama process is down. Cleared by the next successful sync. Ctx.snapshot() surfaces this on
   *  the returned Snapshot so search/find_analogies can tell a learner "no semantic ranking right
   *  now" instead of quietly degrading to lexical-only with no explanation. */
  private lastError: string | undefined;

  /**
   * Bring the index up to date WITHOUT making the caller wait.
   *
   * A freshly compiled 273-page vault took over five minutes to answer its first question, because
   * the snapshot awaited a full sync and the ollama provider embeds one page per HTTP call. Search
   * is lexical-first and the index only augments it, so that wait bought nothing: it just looked
   * like a hung tutor. Deletions are pruned synchronously (free, and keeps the index honest);
   * embedding runs in the background and the index serves whatever it already has meanwhile.
   */
  startSync(pages: Map<string, Page>): void {
    if (this.running) return;
    this.running = this.sync(pages)
      .then(() => { this.lastError = undefined; })
      .catch((e) => {
        this.lastError = (e as Error).message;
        console.error('[embeddings] background sync failed:', this.lastError);
      })
      .finally(() => { this.running = null; });
  }

  /** Await any in-flight background sync — for tests and for callers that genuinely need the
   *  index complete (nothing in the request path should). */
  async settled(): Promise<void> {
    await this.running;
  }

  lastSyncError(): string | undefined {
    return this.lastError;
  }

  /** Embed ONE page synchronously, waiting out any in-flight background sync first so the two
   *  never race the same cache write. write_page's caller needs THIS page findable for proposeLinks
   *  right now — startSync's whole-vault sync is deliberately fire-and-forget (see its comment
   *  above), and during a bulk compile it's often already running against an OLDER page set, so
   *  its early-return left a just-written page permanently unembedded for this call. Syncing one
   *  page is cheap enough to actually await. */
  async syncOne(page: Page): Promise<void> {
    await this.running;
    const hash = createHash('sha256').update(`${page.meta.title}\n\n${page.body}`).digest('hex');
    if (this.data.entries[page.slug]?.hash === hash) return;
    const [vector] = await this.provider.embed([`${page.meta.title}\n\n${page.body}`]);
    this.data.entries[page.slug] = { hash, vector };
    this.persist();
  }

  /** mkdir on every write, not just in the constructor: `.index` is a rebuildable cache, so it gets
   *  deleted while the server is up (by hand, or by a test harness resetting the vault), and a
   *  one-time mkdir turned that into ENOENT on every sync for the rest of the process. */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
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
    this.persist();
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
