import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider, getProvider } from '../src/embeddings/provider.js';
import { EmbeddingIndex, cosine } from '../src/embeddings/index.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

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
});
