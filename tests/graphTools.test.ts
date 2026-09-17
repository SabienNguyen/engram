import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ctx } from '../src/server/context.js';
import { registerGraphTools } from '../src/server/graphTools.js';
import { FakeProvider } from '../src/embeddings/provider.js';
import type { EmbeddingProvider } from '../src/embeddings/provider.js';

let client: Client;
let root: string;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lw-srv-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'chain-rule.md'),
    '---\ntitle: Chain Rule\nstatus: solid\ntags: [calculus]\n---\nderivative of composed functions'
  );
  writeFileSync(
    join(root, 'pages', 'backprop.md'),
    '---\ntitle: Backpropagation\nprereqs: [chain-rule]\n---\ngradients backwards through layers'
  );
  const server = new McpServer({ name: 'engram-test', version: '0.0.0' });
  registerGraphTools(server, new Ctx(root, new FakeProvider()));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});

describe('graph tools', () => {
  it.each(['prereq', 'deepens'])('unlink removes every duplicate %s target', async (type) => {
    const field = type === 'prereq' ? 'prereqs' : 'deepens';
    await call('write_page', {
      slug: 'backprop', title: 'Backprop', body: 'Body',
      [field]: ['chain-rule', 'Chain Rule'],
    });
    expect((await call('unlink_pages', { src: 'backprop', dst: 'chain-rule', type })).isError).toBe(false);
    const { data } = await call('read_page', { slug: 'backprop' });
    expect(data.page.meta[field]).not.toContain('chain-rule');
    expect(data.edges.out.some((e: any) => e.type === type && e.dst === 'chain-rule')).toBe(false);
  });
  it('preserves dollar sequences in related-link rationales verbatim', async () => {
    await call('write_page', { slug: 'chain-rule', title: 'Chain Rule', body: 'Intro\n\n## Links\n' });
    const rationale = 'Compare $& and $$ in the worked example';
    await call('link_pages', { src: 'chain-rule', dst: 'backprop', type: 'related', rationale });
    const { data } = await call('read_page', { slug: 'chain-rule' });
    expect(data.page.body).toContain(`- [[backprop]] — ${rationale}`);
  });
  it('list_pages returns every page metadata row in one call, no bodies', async () => {
    const { data } = await call('list_pages', {});
    expect(data.pages).toHaveLength(2);
    const backprop = data.pages.find((p: any) => p.slug === 'backprop');
    expect(backprop).toMatchObject({ title: 'Backpropagation', prereqs: ['chain-rule'] });
    expect(backprop.body).toBeUndefined();
  });

  it('search ranks title matches first', async () => {
    const { data } = await call('search', { query: 'chain rule' });
    expect(data.results[0].slug).toBe('chain-rule');
    expect(data.note).toBeUndefined();
  });

  it('search returns empty results (not confident semantic noise) on zero lexical hits', async () => {
    const { data } = await call('search', { query: 'zzz-totally-unrelated-nonsense-query-xyz' });
    expect(data.results).toEqual([]);
  });

  it('search surfaces a note when the embeddings provider is unavailable', async () => {
    const failRoot = mkdtempSync(join(tmpdir(), 'lw-srv-fail-'));
    mkdirSync(join(failRoot, 'pages'), { recursive: true });
    writeFileSync(
      join(failRoot, 'pages', 'derivatives.md'),
      '---\ntitle: Derivatives\nstatus: solid\n---\nrates of change'
    );
    const failing: EmbeddingProvider = {
      name: 'failing',
      async embed() {
        throw new Error('ollama unreachable: fetch failed');
      },
    };
    const failServer = new McpServer({ name: 'engram-test-fail', version: '0.0.0' });
    registerGraphTools(failServer, new Ctx(failRoot, failing));
    const [fct, fst] = InMemoryTransport.createLinkedPair();
    const failClient = new Client({ name: 'test-client-fail', version: '0.0.0' });
    await Promise.all([failClient.connect(fct), failServer.connect(fst)]);
    const failCall = async (name: string, args: Record<string, unknown>) => {
      const res = await failClient.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0].text;
      return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
    };

    // The first search kicks off the background sync; its failure isn't known yet.
    await failCall('search', { query: 'derivatives' });
    // Give the (immediately-rejecting) background sync a tick to record its failure.
    await new Promise((r) => setTimeout(r, 20));
    const { data } = await failCall('search', { query: 'derivatives' });
    expect(data.note).toMatch(/embeddings unavailable/);
    expect(data.results[0].slug).toBe('derivatives'); // lexical results still work
  });

  it('read_page returns page with typed in/out edges', async () => {
    const { data } = await call('read_page', { slug: 'chain-rule' });
    expect(data.page.meta.title).toBe('Chain Rule');
    expect(data.edges.in).toContainEqual(expect.objectContaining({ src: 'backprop', type: 'prereq' }));
  });

  it('read_page errors on unknown slug', async () => {
    const { isError, text } = await call('read_page', { slug: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('page not found');
  });

  it('write_page creates a page and proposes links with contract', async () => {
    const { data } = await call('write_page', {
      slug: 'gradient-descent', title: 'Gradient Descent',
      body: 'step along gradients of composed functions', difficulty: 2,
    });
    expect(data.page.slug).toBe('gradient-descent');
    expect(data.instructions).toContain('rationale');
    expect(Array.isArray(data.proposedLinks)).toBe(true);
  });

  it('link_pages adds a prereq, creates stubs, rejects cycles', async () => {
    const stub = await call('link_pages', {
      src: 'chain-rule', dst: 'derivatives', type: 'prereq', rationale: 'composition needs basic derivatives',
    });
    expect(stub.data.stubCreated).toBe(true);
    const cyc = await call('link_pages', {
      src: 'chain-rule', dst: 'backprop', type: 'prereq', rationale: 'circular dependency attempt',
    });
    expect(cyc.isError).toBe(true);
    expect(cyc.text).toContain('cycle');
    const page = await call('read_page', { slug: 'chain-rule' });
    const out = page.data.edges.out;
    expect(out).toContainEqual(expect.objectContaining({ dst: 'derivatives', type: 'prereq', rationale: 'composition needs basic derivatives' }));
  });

  it('unlink_pages removes frontmatter edges but refuses related', async () => {
    await call('unlink_pages', { src: 'backprop', dst: 'chain-rule', type: 'prereq' });
    const page = await call('read_page', { slug: 'backprop' });
    expect(page.data.edges.out.filter((e: any) => e.type === 'prereq')).toHaveLength(0);
    const rel = await call('unlink_pages', { src: 'backprop', dst: 'x', type: 'related' });
    expect(rel.isError).toBe(true);
  });

  it('link_pages leaves the vault unchanged when a cycle is rejected', async () => {
    const before = await call('read_page', { slug: 'chain-rule' });
    const cyc = await call('link_pages', {
      src: 'chain-rule', dst: 'backprop', type: 'prereq', rationale: 'circular dependency attempt',
    });
    expect(cyc.isError).toBe(true);
    expect(cyc.text).toContain('cycle');
    const after = await call('read_page', { slug: 'chain-rule' });
    expect(after.data.edges.out).toEqual(before.data.edges.out);
  });

  it('write_page strips a prereq that would create a cycle and warns', async () => {
    await call('write_page', {
      slug: 'a', title: 'A', body: 'a body', prereqs: ['b'],
    });
    const second = await call('write_page', {
      slug: 'b', title: 'B', body: 'b body', prereqs: ['a'],
    });
    expect(second.data.graphWarnings.some((w: string) => w.includes('rejected') && w.includes('cycle'))).toBe(true);
    const page = await call('read_page', { slug: 'b' });
    expect(page.data.page.meta.prereqs).not.toContain('a');
  });

  it('write_page catches a cycle even when the prereq is named in free text, not a slug', async () => {
    // The cycle check runs against slug-keyed edges, so a prereq passed as "A" (the title form of
    // page "a") must be slugified before the check — otherwise it slips past, is stored raw, and
    // re-reads as "a", quietly forming the b->a->b cycle the check exists to forbid.
    await call('write_page', { slug: 'a', title: 'A', body: 'a body', prereqs: ['b'] });
    const second = await call('write_page', { slug: 'b', title: 'B', body: 'b body', prereqs: ['A'] });
    expect(second.data.graphWarnings.some((w: string) => w.includes('rejected') && w.includes('cycle'))).toBe(true);
    const page = await call('read_page', { slug: 'b' });
    expect(page.data.page.meta.prereqs).not.toContain('a');
  });

  it('write_page slugifies deepens and tags the way read_page reads them back', async () => {
    const created = await call('write_page', {
      slug: 'topic', title: 'Topic', body: 'body', deepens: ['Chain Rule'], tags: ['Machine Learning'],
    });
    expect(created.data.page.meta.deepens).toEqual(['chain-rule']);
    expect(created.data.page.meta.tags).toEqual(['machine-learning']);
    // and the stored form matches, so a reload does not change the metadata under the tutor.
    const read = await call('read_page', { slug: 'topic' });
    expect(read.data.page.meta.deepens).toEqual(['chain-rule']);
    expect(read.data.page.meta.tags).toEqual(['machine-learning']);
  });

  it('write_page slugifies free-text slugs and read_page finds them by slug', async () => {
    const created = await call('write_page', {
      slug: 'Chain Rule 2', title: 'Chain Rule 2', body: 'a second chain rule page',
    });
    expect(created.data.page.slug).toBe('chain-rule-2');
    const files = readdirSync(join(root, 'pages'));
    expect(files).not.toContain('Chain Rule 2.md');
    expect(files).toContain('chain-rule-2.md');
    const read = await call('read_page', { slug: 'Chain Rule 2' });
    expect(read.data.page.slug).toBe('chain-rule-2');
  });

  it('link_pages slugifies dst so it does not create a duplicate stub for an existing page', async () => {
    const before = readdirSync(join(root, 'pages')).length;
    await call('link_pages', {
      src: 'chain-rule', dst: 'Chain Rule', type: 'related', rationale: 'same page different casing test',
    });
    const after = readdirSync(join(root, 'pages')).length;
    expect(after).toBe(before);
    expect(existsSync(join(root, 'pages', 'Chain Rule.md'))).toBe(false);
  });

  it('link_pages related links are idempotent on retry', async () => {
    await call('link_pages', {
      src: 'backprop', dst: 'chain-rule', type: 'related', rationale: 'lateral framing of composition reuse',
    });
    await call('link_pages', {
      src: 'backprop', dst: 'chain-rule', type: 'related', rationale: 'lateral framing of composition reuse',
    });
    const page = await call('read_page', { slug: 'backprop' });
    const occurrences = (page.data.page.body.match(/\[\[chain-rule\]\]/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('a related link does not mangle a body heading that merely starts with "## Links"', async () => {
    // A model-authored section titled "## Links to further reading" contains "## Links" as a
    // substring; a bare replace injected the new bullet mid-heading and orphaned the rest. The exact
    // heading must survive intact, and the new link goes in its own fresh "## Links" section.
    writeFileSync(
      join(root, 'pages', 'topic.md'),
      '---\ntitle: Topic\nstatus: solid\n---\nbody text\n\n## Links to further reading\n- see the textbook\n',
    );
    await call('link_pages', {
      src: 'topic', dst: 'chain-rule', type: 'related', rationale: 'lateral connection worth following',
    });
    const { data } = await call('read_page', { slug: 'topic' });
    const body = data.page.body as string;
    expect(body).toContain('## Links to further reading'); // original heading intact, not "## Links\n…"
    expect(body).toContain('- see the textbook');          // its original content intact
    expect(body).toMatch(/\[\[chain-rule\]\]/);            // the new link landed
  });

  it('two concurrent link_pages on the same src both land — no lost update', async () => {
    // Without a write queue, each handler does await snapshot() -> compute -> write: both read
    // chain-rule's deepens list before either writes it back, so the second write clobbers the
    // first. ctx.serialize makes the whole handler body run to completion before the next one
    // starts, so both edges must survive.
    const a = call('link_pages', {
      src: 'chain-rule', dst: 'jacobians', type: 'deepens', rationale: 'concurrent write A landing test',
    });
    const b = call('link_pages', {
      src: 'chain-rule', dst: 'eigenvalues', type: 'deepens', rationale: 'concurrent write B landing test',
    });
    await Promise.all([a, b]);
    const { data } = await call('read_page', { slug: 'chain-rule' });
    expect(data.page.meta.deepens).toContain('jacobians');
    expect(data.page.meta.deepens).toContain('eigenvalues');
  });

  it('write_page sees a page embedded by a still-running background sync, not just its own snapshot', async () => {
    // Reproduces the bulk-compile bug: write_page's second snapshot() used to hit startSync's
    // early-return whenever a PRIOR write's background embed was still in flight, so the page just
    // written never got its own vector and proposeLinks saw no semantic candidates for it at all.
    const freshRoot = mkdtempSync(join(tmpdir(), 'lw-fresh-'));
    mkdirSync(join(freshRoot, 'pages'), { recursive: true });
    writeFileSync(
      join(freshRoot, 'pages', 'similar-topic.md'),
      '---\ntitle: Similar Topic\nstatus: solid\n---\niterative optimization stepping along gradients'
    );
    const slow: EmbeddingProvider = {
      name: 'slow-fake',
      async embed(texts) {
        await new Promise((r) => setTimeout(r, 40));
        return new FakeProvider().embed(texts);
      },
    };
    const freshCtx = new Ctx(freshRoot, slow);
    const freshServer = new McpServer({ name: 'engram-test-fresh', version: '0.0.0' });
    registerGraphTools(freshServer, freshCtx);
    const [fct, fst] = InMemoryTransport.createLinkedPair();
    const freshClient = new Client({ name: 'test-client-fresh', version: '0.0.0' });
    await Promise.all([freshClient.connect(fct), freshServer.connect(fst)]);
    const freshCall = async (name: string, args: Record<string, unknown>) => {
      const res = await freshClient.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0].text;
      return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
    };

    // Write an unrelated page: its own first snapshot() starts a 40ms background embed of the
    // pre-existing page, which its second snapshot then has to wait out.
    await freshCall('write_page', {
      slug: 'unrelated', title: 'Unrelated', body: 'flour water yeast oven proofing crust',
    });
    // Now write a page with a near-duplicate body — it must be embedded and see the pre-existing
    // similar page as a semantic candidate, regardless of the sync that just ran for the write above.
    const { data } = await freshCall('write_page', {
      slug: 'gradient-descent', title: 'Gradient Descent',
      body: 'iterative optimization stepping along gradients',
    });
    expect(data.proposedLinks.some((c: any) => c.dst === 'similar-topic')).toBe(true);
  }, 10_000);
});
