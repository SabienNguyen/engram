import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeLinks, VERIFY_CONTRACT } from '../src/linking/propose.js';
import { EmbeddingIndex } from '../src/embeddings/index.js';
import { FakeProvider } from '../src/embeddings/provider.js';
import { buildEdges } from '../src/graph/graph.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

const pages = new Map<string, Page>([
  ['backprop', parsePage('backprop', '', '---\nprereqs: [chain-rule]\n---\nGradient flow uses the chain rule repeatedly.')],
  ['chain-rule', parsePage('chain-rule', '', 'Derivative of composed functions.')],
  ['gradient-descent', parsePage('gradient-descent', '', 'Gradient flow: step along gradients repeatedly.')],
  ['baking-bread', parsePage('baking-bread', '', 'flour water yeast oven')],
]);

describe('proposeLinks', () => {
  it('proposes semantic + lexical candidates, excluding self and existing edges', async () => {
    const idx = new EmbeddingIndex(mkdtempSync(join(tmpdir(), 'lw-')), new FakeProvider());
    await idx.sync(pages);
    const cands = proposeLinks(pages.get('backprop')!, pages, buildEdges(pages), idx);
    const dsts = cands.map((c) => c.dst);
    expect(dsts).toContain('gradient-descent');
    expect(dsts).not.toContain('backprop'); // self
    expect(dsts).not.toContain('chain-rule'); // existing prereq edge
    expect(cands.length).toBeLessThanOrEqual(10);
  });

  it('works lexical-only without an index', () => {
    const cands = proposeLinks(pages.get('gradient-descent')!, pages, buildEdges(pages), null);
    expect(cands.every((c) => c.via === 'lexical')).toBe(true);
  });

  it('contract demands a rationale and link_pages callback', () => {
    expect(VERIFY_CONTRACT).toContain('rationale');
    expect(VERIFY_CONTRACT).toContain('link_pages');
    expect(VERIFY_CONTRACT).toContain('prereq');
  });
});
