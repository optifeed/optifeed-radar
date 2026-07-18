import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';
import { createFetcher } from '../core/fetcher/index.js';
import type { ToolContext } from './deps.js';
import { nodeSnapshotFs } from '../core/output/index.js';

// A ToolContext wired for a zero-key audit: only the fetcher matters.
function auditOnlyContext(): ToolContext {
  const fetcher = createFetcher({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('robots.txt')) {
        return new Response('User-agent: GPTBot\nDisallow: /', { status: 200 });
      }
      return new Response(
        '<html><head><title>Acme</title></head><body>Acme store</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
  });
  return {
    resolveStateDir: (d) => `/tmp/optifeed-test/${d}`,
    checkDeps: async () => {
      throw new Error('not used in this test');
    },
    queryDeps: async () => ({ fetcher }),
    fetcher,
    snapshotFs: nodeSnapshotFs(),
    availableEngines: () => [],
    now: () => '2026-07-18T00:00:00.000Z',
    log: () => {},
  };
}

async function connectedClient(ctx: ToolContext): Promise<Client> {
  const server = createServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('MCP server', () => {
  it('lists the 4 launch-1 tools', async () => {
    const client = await connectedClient(auditOnlyContext());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_store',
      'check_visibility',
      'generate_buyer_queries',
      'get_snapshot_diff',
    ]);
    for (const t of tools)
      expect((t.description ?? '').length).toBeGreaterThan(20);
    await client.close();
  });

  it('runs audit_store over a mocked fetcher (zero network) and returns AuditReport JSON', async () => {
    const client = await connectedClient(auditOnlyContext());
    const res = await client.callTool({
      name: 'audit_store',
      arguments: { domain: 'acme.example' },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    const report = JSON.parse(text);
    expect(report.schema_version).toBeTruthy();
    expect(report.domain).toBe('acme.example');
    expect(typeof report.score).toBe('number');
    expect(
      (res as { structuredContent?: unknown }).structuredContent,
    ).toBeDefined();
    await client.close();
  });
});
