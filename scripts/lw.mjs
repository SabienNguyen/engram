// Tiny MCP client for driving the loreweaver server from the CLI.
// Usage: node lw.mjs <tool> '<json-args>'   (or: node lw.mjs list)
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Derived from this file's own location, not hardcoded: the previous absolute path meant the tool
// only ran on the machine it was written on, and failed anywhere else with a MODULE_NOT_FOUND for a
// directory that does not exist. scripts/ -> repo root.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// No default vault path for the same reason. A wrong default is worse than a missing one here:
// pointed at a directory that does not exist, the server would create it and quietly write a second
// empty vault instead of telling you the variable was unset.
const VAULT = process.env.LOREWEAVER_VAULT;
if (!VAULT) {
  console.error('Set LOREWEAVER_VAULT to your vault directory.');
  process.exit(1);
}
const EMB = process.env.LOREWEAVER_EMBEDDINGS ?? 'ollama';

const [tool, argsJson] = process.argv.slice(2);
const client = new Client({ name: 'lw-cli', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(REPO, 'src/server.ts')],
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
