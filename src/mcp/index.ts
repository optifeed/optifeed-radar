#!/usr/bin/env node
/**
 * MCP stdio entrypoint (`optifeed-mcp`). Builds the real, non-interactive
 * ToolContext from the environment and serves the 4 tools over stdio. Thin:
 * all logic is in server.ts / tools.ts / core (hard rule #1).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { defaultToolContext } from './deps.js';
import { mcpContextInput } from './entry.js';

async function main(): Promise<void> {
  const ctx = defaultToolContext(mcpContextInput());
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdout is the MCP stream; never write logs there. A ready line on stderr
  // helps humans confirm the server started.
  process.stderr.write('optifeed-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`optifeed-mcp: fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
