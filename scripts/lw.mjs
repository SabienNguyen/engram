// Tiny MCP client for driving the loreweaver server from the CLI.
// Usage: node lw.mjs <tool> '<json-args>'   (or: node lw.mjs list)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = '/home/sabien/Dev/personal/loreweaver';
const VAULT = process.env.LOREWEAVER_VAULT ?? '/home/sabien/Dev/personal/loreweaver-vault';
const EMB = process.env.LOREWEAVER_EMBEDDINGS ?? 'ollama';

const [tool, argsJson] = process.argv.slice(2);
const client = new Client({ name: 'lw-cli', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['tsx', `${REPO}/src/server.ts`],
    env: { ...process.env, LOREWEAVER_VAULT: VAULT, LOREWEAVER_EMBEDDINGS: EMB },
  })
);

if (tool === 'list') {
  const { tools } = await client.listTools();
  console.log(tools.map((t) => t.name).join('\n'));
} else {
  const res = await client.callTool({ name: tool, arguments: JSON.parse(argsJson ?? '{}') });
  const text = res.content[0].text;
  if (res.isError) console.log('ERROR:', text);
  else {
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
  }
}
await client.close();
