import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ctx } from '../src/server/context.js';
import { registerGraphTools } from '../src/server/graphTools.js';
import { registerTeachTools } from '../src/server/teachTools.js';
import { FakeProvider } from '../src/embeddings/provider.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-teach-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  mkdirSync(join(root, 'raw'), { recursive: true });
  writeFileSync(join(root, 'pages', 'derivatives.md'), '---\ntitle: Derivatives\ndifficulty: 1\n---\nrates of change');
  writeFileSync(join(root, 'pages', 'chain-rule.md'), '---\ntitle: Chain Rule\nprereqs: [derivatives]\ndifficulty: 2\n---\ncomposed derivatives');
  writeFileSync(join(root, 'raw', 'lecture.md'), 'Today we cover the chain rule and gradients.');
  const server = new McpServer({ name: 'loreweaver-test', version: '0.0.0' });
  const ctx = new Ctx(root, new FakeProvider());
  registerGraphTools(server, ctx);
  registerTeachTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
});

describe('teach tools', () => {
  it('compile_source returns source + contract, errors on missing file', async () => {
    const { data } = await call('compile_source', { file: 'lecture.md' });
    expect(data.source).toContain('chain rule');
    expect(data.instructions).toContain('write_page');
    expect(data.existingPages.map((p: any) => p.slug)).toContain('chain-rule');
    expect((await call('compile_source', { file: 'nope.md' })).isError).toBe(true);
  });

  it('paths: create validates page existence, then read/list', async () => {
    const bad = await call('create_path', { slug: 'p', title: 'P', pages: ['nope'], narrative: 'x' });
    expect(bad.isError).toBe(true);
    await call('create_path', { slug: 'calc', title: 'Calc Trail', pages: ['derivatives', 'chain-rule'], narrative: 'From zero to chain rule.' });
    expect((await call('list_paths', {})).data).toHaveLength(1);
    expect((await call('read_path', { slug: 'calc' })).data.pages).toEqual(['derivatives', 'chain-rule']);
  });

  it('record_evidence updates state; get_student_state reflects it', async () => {
    const rec = await call('record_evidence', {
      student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'nailed limits framing',
    });
    expect(rec.data.level).toBe('exposed'); // unseen -> one above = exposed
    const state = await call('get_student_state', { student: 'sabien' });
    expect(state.data.derivatives.evidenceCount).toBe(1);
    expect((await call('record_evidence', { student: 's', slug: 'nope', kind: 'exposed', note: 'x' })).isError).toBe(true);
  });

  it('next_lessons suggests frontier work for a fresh student', async () => {
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'a' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'b' });
    // derivatives now practicing => chain-rule unlocked
    const { data } = await call('next_lessons', { student: 'sabien' });
    expect(data.map((s: any) => s.slug)).toContain('chain-rule');
  });

  it('find_analogies returns known neighbors', async () => {
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'a' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'b' });
    const { data } = await call('find_analogies', { student: 'sabien', slug: 'chain-rule' });
    expect(data.analogies.map((a: any) => a.slug)).toEqual(['derivatives']);
  });
});
