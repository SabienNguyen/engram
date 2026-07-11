import { describe, it, expect } from 'vitest';
import { buildEdges, missingTargets, wouldCreateCycle, graphWarnings } from '../src/graph/graph.js';
import { parsePage } from '../src/vault/parsePage.js';
import type { Page } from '../src/types.js';

function vault(...entries: [string, string][]): Map<string, Page> {
  return new Map(entries.map(([slug, raw]) => [slug, parsePage(slug, '', raw)]));
}

const pages = vault(
  ['backprop', '---\nprereqs: [chain-rule]\ndeepens: [jacobians]\n---\nSee [[chain-rule]] and [[dp]].'],
  ['chain-rule', '---\nprereqs: [derivatives]\n---\nbody'],
  ['jacobians', 'body'],
  ['derivatives', 'body'],
);

describe('graph', () => {
  it('builds typed, deduped edges', () => {
    const edges = buildEdges(pages);
    expect(edges).toContainEqual({ src: 'backprop', dst: 'chain-rule', type: 'prereq' });
    expect(edges).toContainEqual({ src: 'backprop', dst: 'jacobians', type: 'deepens' });
    expect(edges).toContainEqual({ src: 'backprop', dst: 'dp', type: 'related' });
    // inline [[chain-rule]] does NOT duplicate the prereq edge as related? It is a distinct type: related edge allowed.
    expect(edges.filter((e) => e.src === 'backprop' && e.dst === 'chain-rule')).toHaveLength(2);
  });

  it('finds missing targets', () => {
    expect(missingTargets(pages, buildEdges(pages))).toEqual(['dp']);
  });

  it('detects prereq cycles transitively', () => {
    const edges = buildEdges(pages);
    // derivatives -> backprop would close: backprop -> chain-rule -> derivatives -> backprop
    expect(wouldCreateCycle(edges, 'derivatives', 'backprop')).toBe(true);
    expect(wouldCreateCycle(edges, 'jacobians', 'derivatives')).toBe(false);
    expect(wouldCreateCycle(edges, 'x', 'x')).toBe(true);
  });

  it('warns on orphans and hubs', () => {
    const w = graphWarnings(pages, buildEdges(pages));
    expect(w).toContain('orphan: backprop');
    expect(w.some((x) => x.startsWith('hub:'))).toBe(false);
  });
});
