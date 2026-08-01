import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider, getProvider } from '../src/embeddings/provider.js';
import { EmbeddingIndex, cosine } from '../src/embeddings/index.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';
import type { EmbeddingProvider } from '../src/embeddings/provider.js';

const pages = new Map<string, Page>([
  ['gradient-descent', parsePage('gradient-descent', '', 'iterative optimization stepping along gradients')],
  ['kelly-criterion', parsePage('kelly-criterion', '', 'iterative optimization of bet size fraction')],
  ['baking-bread', parsePage('baking-bread', '', 'flour water yeast oven proofing crust')],
]);

describe('embeddings', () => {
  it('FakeProvider is deterministic and rates similar texts closer', async () => {
    const p = new FakeProvider();
    const [a1] = await p.embed(['iterative optimization']);
    const [a2] = await p.embed(['iterative optimization']);
    expect(a1).toEqual(a2);
    const [gd, kelly, bread] = await p.embed([
      'iterative optimization stepping along gradients',
      'iterative optimization of bet size fraction',
      'flour water yeast oven proofing crust',
    ]);
    expect(cosine(gd, kelly)).toBeGreaterThan(cosine(gd, bread));
  });

  it('getProvider honors env', () => {
    expect(getProvider({ LOREWEAVER_EMBEDDINGS: 'none' })).toBeNull();
    expect(getProvider({ LOREWEAVER_EMBEDDINGS: 'fake' })?.name).toBe('fake');
    expect(getProvider({})?.name).toBe('ollama');
  });

  it('index syncs, persists, and ranks neighbors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-idx-'));
    const idx = new EmbeddingIndex(dir, new FakeProvider());
    await idx.sync(pages);
    const near = idx.similarTo('gradient-descent', 2);
    expect(near[0].slug).toBe('kelly-criterion');
    // reload from disk: no re-embed needed, same results
    const idx2 = new EmbeddingIndex(dir, new FakeProvider());
    await idx2.sync(pages);
    expect(idx2.similarTo('gradient-descent', 1)[0].slug).toBe('kelly-criterion');
    // similarToMany with filter
    const many = idx2.similarToMany(['gradient-descent'], 5, (s) => s !== 'baking-bread');
    expect(many.map((m) => m.slug)).toEqual(['kelly-criterion']);
  });

  it('a corrupt cache file self-heals instead of disabling search forever', async () => {
    // writeFileSync (sync) is not atomic — a crash or disk-full mid-write truncates embeddings.json.
    // A bare JSON.parse threw straight out of the constructor, and since that beat sync()'s rewrite
    // the file was never repaired: semantic search stayed dead every session after. Degrading a bad
    // cache to empty lets the very next sync rebuild it.
    const dir = mkdtempSync(join(tmpdir(), 'lw-idx-'));
    writeFileSync(join(dir, 'embeddings.json'), '{"provider":"fake","entries":{"gradient-des'); // truncated
    const idx = new EmbeddingIndex(dir, new FakeProvider());
    await idx.sync(pages); // must not throw
    expect(idx.similarTo('gradient-descent', 1)[0].slug).toBe('kelly-criterion');
  });

  it('a cache from a different provider is rebuilt, not compared across models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-idx-'));
    // A well-formed cache, but tagged as another provider's — its vectors aren't comparable.
    writeFileSync(join(dir, 'embeddings.json'),
      JSON.stringify({ provider: 'some-other-model', entries: { 'x': { hash: 'h', vector: [1, 2, 3] } } }));
    const idx = new EmbeddingIndex(dir, new FakeProvider());
    await idx.sync(pages);
    // The stale 'x' entry is gone (rebuilt from the real pages), and search works.
    expect(idx.similarTo('gradient-descent', 1)[0].slug).toBe('kelly-criterion');
  });
});

/**
 * Search must never wait on embedding. A freshly compiled 273-page PyTorch vault took OVER 300
 * SECONDS to answer its first question, because Ctx.snapshot() awaited a full sync and the ollama
 * provider embeds one page per HTTP call. The learner saw "tutor is working…" for five minutes,
 * and anything they typed meanwhile killed the pending block. The same query with a warm index
 * takes 4s. Search is lexical-first — the index only AUGMENTS it — so blocking on embedding buys
 * nothing at all.
 */
describe('startSync does not block', () => {
  it('returns immediately and fills the index afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emb-bg-'));
    let embedded = 0;
    const slow: EmbeddingProvider = {
      name: 'slow',
      async embed(texts) {
        await new Promise((r) => setTimeout(r, 50));
        embedded += texts.length;
        return texts.map(() => [1, 0, 0]);
      },
    };
    const idx = new EmbeddingIndex(dir, slow);
    const pages = new Map([['a', parsePage('a', '', 'alpha body text')], ['b', parsePage('b', '', 'beta body text')]]);

    const t0 = Date.now();
    idx.startSync(pages);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(25);   // did not wait for the 50ms embed
    expect(embedded).toBe(0);

    await idx.settled();               // the work still happens
    expect(embedded).toBe(2);
  });

  it('coalesces overlapping syncs instead of embedding twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emb-bg2-'));
    let calls = 0;
    const p: EmbeddingProvider = {
      name: 'count',
      async embed(texts) { calls += 1; await new Promise((r) => setTimeout(r, 30)); return texts.map(() => [1, 0, 0]); },
    };
    const idx = new EmbeddingIndex(dir, p);
    const pages = new Map([['a', parsePage('a', '', 'alpha body text')]]);
    idx.startSync(pages);
    idx.startSync(pages);
    idx.startSync(pages);
    await idx.settled();
    expect(calls).toBe(1);
  });
});
