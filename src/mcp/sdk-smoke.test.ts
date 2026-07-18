import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('MCP SDK import surface', () => {
  it('resolves the server/client/transport subpaths used by M15', () => {
    expect(Server).toBeTypeOf('function');
    expect(StdioServerTransport).toBeTypeOf('function');
    expect(Client).toBeTypeOf('function');
    expect(InMemoryTransport).toBeTypeOf('function');
    expect(ListToolsRequestSchema).toBeTruthy();
    expect(CallToolRequestSchema).toBeTruthy();
  });
});
