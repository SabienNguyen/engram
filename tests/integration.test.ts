import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { data: res.isError ? undefined : JSON.parse(text), text, isError: !!res.isError };
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lw-e2e-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'derivatives.md'), '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve('src/server.ts')],
      env: {
        ...process.env as Record<string, string>,
        LOREWEAVER_VAULT: root,
        LOREWEAVER_EMBEDDINGS: 'fake',
      },
    })
  );
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe('engram over stdio', () => {
  it('lists all 14 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'compile_source', 'create_path', 'find_analogies', 'get_student_state',
      'link_pages', 'list_pages', 'list_paths', 'next_lessons', 'read_page', 'read_path',
      'record_evidence', 'search', 'unlink_pages', 'write_page',
    ]);
  });

  it('teaching loop: write, link, evidence, next_lessons', async () => {
    const wp = await call('write_page', {
      slug: 'chain-rule', title: 'Chain Rule', body: 'composed derivatives, rates of change',
      difficulty: 2,
    });
    expect(wp.data.instructions).toContain('rationale');

    const lp = await call('link_pages', {
      src: 'chain-rule', dst: 'derivatives', type: 'prereq',
      rationale: 'composition derivative needs single-function derivatives first',
    });
    expect(lp.data.linked.type).toBe('prereq');

    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'explained-correctly', note: 'solid' });
    await call('record_evidence', { student: 'sabien', slug: 'derivatives', kind: 'applied-correctly', note: 'solid' });

    const nl = await call('next_lessons', { student: 'sabien' });
    expect(nl.data.lessons.map((s: any) => s.slug)).toContain('chain-rule');
  }, 30_000);
});
