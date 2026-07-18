/**
 * The MCP server: registers the 4 tools over the low-level SDK `Server` with
 * raw JSON-Schema definitions (no zod dependency). Pure of process I/O - it
 * takes an injected `ToolContext`, so tests drive it over an in-memory
 * transport with a mocked fetcher (hard rule #3). The stdio wiring lives in
 * index.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SPECS, callTool } from './tools.js';
import type { ToolContext } from './deps.js';

/** Build a configured (but not yet connected) MCP server. */
export function createServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'optifeed-visibility', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_SPECS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const progressToken = request.params._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (fraction: number, message: string): void => {
            void server.notification({
              method: 'notifications/progress',
              params: { progressToken, progress: fraction, total: 1, message },
            });
          }
        : undefined;
    const result = await callTool(ctx, name, args ?? {}, onProgress);
    // ToolResult is a deliberately narrow subset of the SDK's broad ServerResult
    // union (which also covers list/init/task-augmented shapes this server
    // never returns for tools/call); the runtime shape is a valid CallToolResult.
    return result as unknown as ServerResult;
  });

  return server;
}
