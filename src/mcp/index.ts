#!/usr/bin/env node
/**
 * MCP stdio entrypoint (`optifeed-mcp`). Builds the real, non-interactive
 * ToolContext from the environment and serves the 4 tools over stdio. Thin:
 * all logic is in server.ts / tools.ts / core (hard rule #1).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { defaultToolContext } from './deps.js';

async function main(): Promise<void> {
  const ctx = defaultToolContext({
    env: process.env,
    cwd: process.cwd(),
    homeDir: process.env.HOME ?? process.cwd(),
    // DELIBERATE: the MCP server always writes state under the HOME dir, unlike
    // the CLI which prefers `<cwd>/.optifeed` when cwd is writable. A server
    // launched by a desktop client has an arbitrary, often non-project cwd (e.g.
    // `/`), so a stable home-anchored location is predictable and avoids
    // scattering `.optifeed` dirs wherever the client happened to start us. The
    // trade-off: snapshots written by a CLI run in a project dir are not visible
    // to `get_snapshot_diff` over MCP (and vice versa). Revisit if agents and
    // humans need to share one brand's history across both entrypoints.
    isProjectWritable: false,
  });
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
