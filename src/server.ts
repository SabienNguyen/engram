import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Ctx } from './server/context.js';
import { registerGraphTools } from './server/graphTools.js';
import { registerTeachTools } from './server/teachTools.js';
import { getProvider } from './embeddings/provider.js';

const root = process.env.ENGRAM_VAULT ?? process.env.LOREWEAVER_VAULT;
if (!root) {
  console.error('ENGRAM_VAULT env var must point to the vault directory');
  process.exit(1);
}

const server = new McpServer({ name: 'engram', version: '0.1.0' });
const ctx = new Ctx(root, getProvider());
registerGraphTools(server, ctx);
registerTeachTools(server, ctx);

await server.connect(new StdioServerTransport());
