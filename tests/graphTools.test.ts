import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ctx } from '../src/server/context.js';
import { registerGraphTools } from '../src/server/graphTools.js';
import { FakeProvider } from '../src/embeddings/provider.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-srv-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'chain-rule.md'),
    '---\ntitle: Chain Rule\nstatus: solid\ntags: [calculus]\n---\nderivative of composed functions'
  );
  writeFileSync(
    join(root, 'pages', 'backprop.md'),
    '---\ntitle: Backpropagation\nprereqs: [chain-rule]\n---\ngradients backwards through layers'
  );
  const server = new McpServer({ name: 'loreweaver-test', version: '0.0.0' });
  registerGraphTools(server, new Ctx(root, new FakeProvider()));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});

describe('graph tools', () => {
  it('search ranks title matches first', async () => {
    const { data } = await call('search', { query: 'chain rule' });
    expect(data[0].slug).toBe('chain-rule');
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
});
