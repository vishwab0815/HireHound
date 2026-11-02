import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from '../core/logger.js';

let client: Client | null = null;

export async function connectPlaywrightMcp(cdpEndpoint: string): Promise<Client> {
  log('AGENT', `Connecting Playwright MCP to Chrome at ${cdpEndpoint}`);

  // Pinned version instead of @latest: pulling whatever is newest on every run would let
  // unreviewed code drive your logged-in browser. Bump it deliberately.
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['@playwright/mcp@0.0.76', '--cdp-endpoint', cdpEndpoint],
  });

  client = new Client({ name: 'hirehound', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  log('AGENT', `Playwright MCP connected, ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  return client;
}

export async function disconnectMcp(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    log('AGENT', 'Playwright MCP disconnected.');
  }
}
