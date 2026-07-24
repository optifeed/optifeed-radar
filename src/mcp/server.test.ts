import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';
import { createFetcher } from '../core/fetcher/index.js';
import type { ToolContext } from './deps.js';
import { nodeSnapshotFs } from '../core/output/index.js';
import { TOOL_SPECS } from './tools.js';

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
    shoppingDeps: async () => {
      throw new Error('not used in this test');
    },
    queryDeps: async () => ({ fetcher }),
    newFetcher: () => fetcher,
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
  it('reports the package version in the handshake (no hardcoded copy to drift)', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const client = await connectedClient(auditOnlyContext());
    expect(client.getServerVersion()).toEqual({
      name: 'optifeed-radar',
      version: pkg.version,
    });
    await client.close();
  });

  it('lists the 5 launch tools', async () => {
    const client = await connectedClient(auditOnlyContext());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_store',
      'check_visibility',
      'generate_buyer_queries',
      'get_snapshot_diff',
      'shopping_check',
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

describe('MCP tool schemas', () => {
  it('input schemas are stable (update the snapshot on purpose when they change)', () => {
    const schemas = Object.fromEntries(
      TOOL_SPECS.map((t) => [t.name, t.inputSchema]),
    );
    expect(schemas).toMatchInlineSnapshot(`
      {
        "audit_store": {
          "properties": {
            "domain": {
              "description": "The brand site, e.g. example.com",
              "type": "string",
            },
          },
          "required": [
            "domain",
          ],
          "type": "object",
        },
        "check_visibility": {
          "properties": {
            "domain": {
              "description": "The brand site, e.g. example.com",
              "type": "string",
            },
            "engines": {
              "description": "Engines to query; defaults to all with keys present",
              "items": {
                "enum": [
                  "openai",
                  "anthropic",
                  "gemini",
                  "perplexity",
                ],
                "type": "string",
              },
              "type": "array",
            },
            "max_cost": {
              "description": "Hard cap on total spend in USD (default 0.50)",
              "type": "number",
            },
            "quick": {
              "description": "Use a smaller 8-prompt pack (cheaper, faster)",
              "type": "boolean",
            },
          },
          "required": [
            "domain",
          ],
          "type": "object",
        },
        "generate_buyer_queries": {
          "properties": {
            "domain": {
              "description": "The brand site, e.g. example.com",
              "type": "string",
            },
          },
          "required": [
            "domain",
          ],
          "type": "object",
        },
        "get_snapshot_diff": {
          "properties": {
            "domain": {
              "description": "The brand site, e.g. example.com",
              "type": "string",
            },
          },
          "required": [
            "domain",
          ],
          "type": "object",
        },
        "shopping_check": {
          "properties": {
            "domain": {
              "description": "The store site, e.g. example.com",
              "type": "string",
            },
            "engines": {
              "description": "Engines to query; defaults to all with keys present",
              "items": {
                "enum": [
                  "openai",
                  "anthropic",
                  "gemini",
                  "perplexity",
                ],
                "type": "string",
              },
              "type": "array",
            },
            "max_cost": {
              "description": "Hard cap on total spend in USD (default $0.20 per product)",
              "type": "number",
            },
            "products": {
              "description": "Up to 10 products, in any order (the order carries no meaning; results are sorted by what the engines did). Each item is a name, or an object with name plus optional aliases and a descriptor ("quiet home espresso machine") that rescues an opaque product name.",
              "items": {
                "oneOf": [
                  {
                    "type": "string",
                  },
                  {
                    "properties": {
                      "aliases": {
                        "items": {
                          "type": "string",
                        },
                        "type": "array",
                      },
                      "descriptor": {
                        "type": "string",
                      },
                      "name": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "name",
                    ],
                    "type": "object",
                  },
                ],
              },
              "maxItems": 10,
              "type": "array",
            },
          },
          "required": [
            "domain",
            "products",
          ],
          "type": "object",
        },
      }
    `);
  });
});

describe('MCP server failure modes', () => {
  it('check_visibility with no engine key returns an honest error result (no throw)', async () => {
    const client = await connectedClient(auditOnlyContext());
    const res = await client.callTool({
      name: 'check_visibility',
      arguments: { domain: 'acme.example' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/api key/i);
    expect(text).toMatch(/audit_store/);
    await client.close();
  });

  it('get_snapshot_diff with fewer than 2 snapshots returns an honest note (not a fabricated diff)', async () => {
    const ctx = auditOnlyContext();
    // Force a deterministic empty snapshot listing (no real disk).
    const emptyCtx: typeof ctx = {
      ...ctx,
      snapshotFs: {
        readFile: () => Promise.reject(new Error('no file')),
        writeFile: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
        readdir: () => Promise.resolve([]),
      },
    };
    const client = await connectedClient(emptyCtx);
    const res = await client.callTool({
      name: 'get_snapshot_diff',
      arguments: { domain: 'acme.example' },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/at least 2|found 0|2 saved runs/i);
    // Even the honest "not enough history" note is a JSON payload and must
    // carry schema_version (hard rule #2).
    expect(JSON.parse(text).schema_version).toBeTruthy();
    await client.close();
  });

  it('generate_buyer_queries with no engine key returns an honest error result', async () => {
    const client = await connectedClient(auditOnlyContext()); // availableEngines() -> []
    const res = await client.callTool({
      name: 'generate_buyer_queries',
      arguments: { domain: 'acme.example' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/api key/i);
    await client.close();
  });

  it('check_visibility with an all-unrecognized engines array errors before spending', async () => {
    // Keys ARE present, so the no-key guard passes; the engines array is all
    // garbage, so it must abort rather than silently query every engine. The
    // context's checkDeps throws if reached - proving it never is.
    const ctx: ToolContext = {
      ...auditOnlyContext(),
      availableEngines: () => ['openai'],
    };
    const client = await connectedClient(ctx);
    const res = await client.callTool({
      name: 'check_visibility',
      arguments: { domain: 'acme.example', engines: ['gpt4', 'bard'] },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/no recognized engines/i);
    await client.close();
  });

  it('rejects a domain with path-traversal characters before touching the filesystem', async () => {
    const client = await connectedClient(auditOnlyContext());
    const res = await client.callTool({
      name: 'audit_store',
      arguments: { domain: '../../etc/passwd' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/not a valid domain/i);
    await client.close();
  });
});
