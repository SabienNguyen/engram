import { describe, it, expect } from 'vitest';
import {
  buildEdges, missingTargets, wouldCreateCycle, graphWarnings, prereqCycles,
} from '../src/graph/graph.js';
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

/** wouldCreateCycle only guards edges this server is asked to ADD. A cycle written straight into
 *  the vault was never reported, and frontier() drops every page in it — the pages vanish from the
 *  curriculum with nothing said. */
describe('prereq cycles already in the vault', () => {
  it('catches a page listing itself, which buildEdges drops before any edge exists', () => {
    const v = vault(['loop', '---\nprereqs: [loop]\n---\nbody']);
    expect(buildEdges(v).filter((e) => e.type === 'prereq')).toEqual([]);
    expect(prereqCycles(v)).toEqual(['cycle: loop -> loop']);
  });

  it('catches a two-page cycle, which takes BOTH pages out of the frontier', () => {
    const v = vault(
      ['a', '---\nprereqs: [b]\n---\nbody'],
      ['b', '---\nprereqs: [a]\n---\nbody'],
    );
    expect(prereqCycles(v)).toEqual(['cycle: a -> b -> a']);
  });

  it('does not mistake a shared prereq reached by two paths for a cycle', () => {
    expect(prereqCycles(pages)).toEqual([]);
    const diamond = vault(
      ['top', '---\nprereqs: [left, right]\n---\nbody'],
      ['left', '---\nprereqs: [base]\n---\nbody'],
      ['right', '---\nprereqs: [base]\n---\nbody'],
      ['base', 'body'],
    );
    expect(prereqCycles(diamond)).toEqual([]);
  });

  it('reports cycles ahead of orphans, so a caller capping the list cannot bury them', () => {
    const entries: [string, string][] = [
      ['a', '---\nprereqs: [b]\n---\nbody'],
      ['b', '---\nprereqs: [a]\n---\nbody'],
    ];
    for (let i = 0; i < 12; i++) entries.push([`orphan-${i}`, 'body']);
    const v = vault(...entries);
    const w = graphWarnings(v, buildEdges(v));
    expect(w[0]).toBe('cycle: a -> b -> a');
    // graphTools slices to 10; a compile's worth of orphans must not push the cycle past that.
    expect(w.slice(0, 10)).toContain('cycle: a -> b -> a');
  });
});
