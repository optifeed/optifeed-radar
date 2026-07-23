import { describe, it, expect, vi } from 'vitest';
import { callTool } from './tools.js';
import type { ToolContext } from './deps.js';
import type { RunCheckDeps, RunShoppingDeps } from '../core/run/index.js';
import { createFetcher } from '../core/fetcher/index.js';
import { CostGuard } from '../core/costs.js';
import type { FetchLike } from '../core/fetcher/index.js';
import type { EngineAdapter } from '../core/engines/index.js';
import { profilePath, type ProfileFs } from '../core/discovery/index.js';
import { queriesPath, toYaml, type QueryFs } from '../core/queries/index.js';
import { shoppingDir } from '../core/shopping/index.js';
import {
  nodeSnapshotFs,
  snapshotFileName,
  snapshotsDir,
  AUDIT_ONLY_NOTE,
  FOOTER_CTA,
  type SnapshotFs,
} from '../core/output/index.js';
import { join } from 'node:path';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
  type QueryPack,
} from '../core/types.js';

const STATE = '/state';
const NOW = (): string => '2026-07-19T00:00:00.000Z';

const CACHED_PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme',
  aliases: ['Acme Co'],
  category: 'widgets',
  competitors: ['Globex', 'Initech'],
  sources: { brand: 'user' },
};

const CACHED_PACK: QueryPack = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  queries: [
    { id: 'q1', intent: 'best-of', prompt: 'best widgets brand?' },
    { id: 'q2', intent: 'comparison', prompt: 'top widget makers?' },
  ],
};

function res(
  body: string,
  status = 200,
): {
  status: number;
  headers: { get(n: string): string | null };
  text(): Promise<string>;
} {
  return {
    status,
    headers: { get: () => 'text/html' },
    text: async () => body,
  };
}

function fakeFetch(): FetchLike {
  const HOME =
    '<html><head><title>Acme</title></head><body>Acme widgets</body></html>';
  return async (url) => {
    const u = url.replace(/\/$/, '');
    if (u.endsWith('robots.txt')) return res('User-agent: *\nAllow: /', 200);
    if (u.endsWith('llms.txt')) return res('not found', 404);
    if (u.endsWith('llms-full.txt')) return res('not found', 404);
    if (u.endsWith('sitemap.xml')) return res('not found', 404);
    return res(HOME, 200);
  };
}

function fakeAdapter(id: EngineId, kind: EngineKind): EngineAdapter {
  const model = `${id}-model`;
  return {
    id,
    kind,
    model,
    available: () => true,
    ask: async (prompt): Promise<EngineAnswer> => ({
      engine: id,
      kind,
      prompt,
      text: 'Acme is a great widget brand.',
      model,
      costUsd: 0.001,
      ts: NOW(),
    }),
  };
}

/** Answers the first cached prompt and fails the second: a partial engine. */
function flakyAdapter(): EngineAdapter {
  const base = fakeAdapter('openai', 'parametric');
  return {
    ...base,
    ask: async (prompt, opts): Promise<EngineAnswer> => {
      if (prompt.includes('top widget makers')) throw new Error('rate limited');
      return base.ask(prompt, opts);
    },
  };
}

function fakeJudge(): JudgeClient {
  return {
    model: 'judge-model',
    complete: async () => ({ text: '{}', costUsd: 0, model: 'judge-model' }),
  };
}

/**
 * Fake filesystems below are keyed with "/" paths, but core builds paths with
 * node:path, which yields "\\" on Windows - and seeds are built by calling the
 * same helpers, so BOTH keys and lookups need normalizing. The CI matrix caught
 * this twice: first lookups, then the seeded keys.
 */
function normKey(p: string): string {
  return p.split('\\').join('/');
}

function memFs(
  seed: Record<string, string> = {},
): ProfileFs & QueryFs & SnapshotFs & { files: Map<string, string> } {
  const files = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [normKey(k), v]),
  );
  const dirs = new Set<string>();
  // Core joins paths with node:path, which yields "\\" on Windows while these
  // seeds use "/". Normalize so the fake fs is platform-agnostic.
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    files,
    async readFile(path: string) {
      return files.get(normKey(path)) ?? notFound();
    },
    async writeFile(path: string, data: string) {
      files.set(normKey(path), data);
    },
    async mkdir(path: string) {
      dirs.add(normKey(path));
    },
    async readdir(path: string) {
      const dir = normKey(path);
      if (!dirs.has(dir)) notFound();
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length));
    },
  };
}

/** A ToolContext wired so check_visibility runs to completion against stubs. */
function workingContext(overrides: Partial<ToolContext> = {}): {
  ctx: ToolContext;
  checkDeps: ReturnType<typeof vi.fn>;
  fs: ReturnType<typeof memFs>;
} {
  const fs = memFs({
    [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
    [queriesPath(STATE)]: toYaml(CACHED_PACK),
  });
  const checkDeps = vi.fn(
    async (): Promise<Omit<RunCheckDeps, 'confirm' | 'onProgress'>> => ({
      fetcher: createFetcher({ fetchImpl: fakeFetch() }),
      adapters: [fakeAdapter('openai', 'parametric')],
      judge: fakeJudge(),
      profileFs: fs,
      queryFs: fs,
      snapshotFs: fs,
      now: NOW,
    }),
  );
  const ctx: ToolContext = {
    resolveStateDir: () => STATE,
    checkDeps,
    queryDeps: async () => ({
      fetcher: createFetcher({ fetchImpl: fakeFetch() }),
      judge: fakeJudge(),
      profileFs: fs,
      queryFs: fs,
      now: NOW,
      persist: false,
    }),
    // Overridden by shoppingContext below; throwing here means a shopping test
    // that forgets to wire deps fails loudly instead of silently doing nothing.
    shoppingDeps: async () => {
      throw new Error('shoppingDeps not wired in this context');
    },
    newFetcher: () => createFetcher({ fetchImpl: fakeFetch() }),
    snapshotFs: nodeSnapshotFs(),
    availableEngines: () => ['openai'],
    now: NOW,
    log: () => {},
    ...overrides,
  };
  return { ctx, checkDeps, fs };
}

/**
 * A context whose snapshot store holds two comparable runs. The clock is fixed
 * (NOW), and snapshots are keyed by `generatedAt`, so a second `check` would
 * overwrite the first - the second snapshot is written directly instead, as a
 * copy of the first stamped an hour later.
 */
async function twoSnapshots(): Promise<{
  ctx: ToolContext;
  fs: ReturnType<typeof memFs>;
}> {
  const { ctx, fs } = workingContext();
  ctx.snapshotFs = fs;
  await callTool(ctx, 'check_visibility', { domain: 'acme.example' });
  const dir = normKey(snapshotsDir(STATE));
  const firstKey = [...fs.files.keys()].find((k) => k.startsWith(`${dir}/`));
  if (!firstKey) throw new Error('the first check saved no snapshot');
  const later = '2026-07-19T01:00:00.000Z';
  const envelope = JSON.parse(fs.files.get(firstKey)!) as Record<
    string,
    unknown
  >;
  envelope.generatedAt = later;
  fs.files.set(
    normKey(join(snapshotsDir(STATE), snapshotFileName(later))),
    JSON.stringify(envelope),
  );
  return { ctx, fs };
}

function textOf(res: { content: { text: string }[] }): string {
  return res.content[0]!.text;
}

/** Every text block after the JSON one, joined - the human-readable channel. */
function proseOf(res: { content: { text: string }[] }): string {
  return res.content
    .slice(1)
    .map((b) => b.text)
    .join('\n');
}

/**
 * The ESC byte that opens every ANSI color sequence. Built from a char code
 * so this file never carries a control-char literal.
 */
const ESC = String.fromCharCode(27);

/**
 * The rendered text block (M15 follow-up). The JSON envelope carries every
 * field, but the honesty scaffolding - the variance note, "not assessed"
 * instead of 0/100, run notes for a partial run, the footer CTA - lives only
 * in the `core/output` text renderers. Without it, whether a caveat reaches
 * the human depends on the host model choosing to repeat it (rule #6).
 */
describe('human-readable text block', () => {
  it('renders check_visibility prose alongside the JSON, keeping content[0] parseable', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    JSON.parse(textOf(res)); // content[0] is still the pure JSON contract
    const prose = proseOf(res);
    expect(prose).toContain('AI Visibility Score');
    // The variance caveat must ship with the number, not be left to the host.
    expect(prose).toContain('estimate');
    expect(prose).toContain(FOOTER_CTA);
  });

  it('renders audit_store prose, including the audit-only caveat', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'audit_store', { domain: 'acme.example' });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    JSON.parse(textOf(res));
    const prose = proseOf(res);
    expect(prose).toContain('AI Visibility Audit');
    expect(prose).toContain(AUDIT_ONLY_NOTE);
  });

  it('renders generate_buyer_queries prose as the readable pack', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'generate_buyer_queries', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    JSON.parse(textOf(res));
    // YAML, the form `queries` prints and exports - not a second copy of JSON.
    const prose = proseOf(res);
    expect(prose.startsWith('schema_version:')).toBe(true);
    expect(prose).toContain('domain: acme.example');
    expect(prose).toContain('queries:');
  });

  it('renders get_snapshot_diff prose', async () => {
    const { ctx, fs } = await twoSnapshots();
    const res = await callTool(ctx, 'get_snapshot_diff', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    JSON.parse(textOf(res));
    expect(proseOf(res)).toContain('AI Visibility change');
    expect(fs.files.size).toBeGreaterThan(0);
  });

  // Failure mode 1: MCP is a pipe, not a TTY, but picocolors auto-detects from
  // the SERVER's stdout. If the server runs somewhere color-capable, escape
  // codes would leak into the model's context as garbage tokens. Every tool
  // whose renderer touches picocolors is covered - render-diff.ts colors too,
  // so get_snapshot_diff needs its own snapshot-backed context.
  it('never emits ANSI escape codes (color forced off, not auto-detected)', async () => {
    const { ctx } = workingContext();
    for (const tool of [
      'check_visibility',
      'audit_store',
      'generate_buyer_queries',
    ]) {
      const res = await callTool(ctx, tool, { domain: 'acme.example' });
      expect(proseOf(res).includes(ESC)).toBe(false);
    }
    const { ctx: diffCtx } = await twoSnapshots();
    const diff = await callTool(diffCtx, 'get_snapshot_diff', {
      domain: 'acme.example',
    });
    expect(proseOf(diff).includes(ESC)).toBe(false);
  });

  // Failure mode 3: generate_buyer_queries is the one tool here that spends
  // money and can hit the cost cap, and its prose is the pack alone. If the
  // cap trips, the JSON says costCapped but a YAML pack looks complete - the
  // exact "caveat depends on the summarizer's taste" problem this block
  // exists to remove (rule #6, and the M8 lesson on propagating honesty to
  // every derived artifact).
  it('carries a capped generation run into the prose, not only the JSON', async () => {
    const fs = memFs({
      [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
      [queriesPath(STATE)]: toYaml(CACHED_PACK),
    });
    const { ctx } = workingContext({
      queryDeps: async () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch() }),
        judge: fakeJudge(),
        guard: new CostGuard({ maxCostUsd: 0.0000001 }),
        profileFs: fs,
        queryFs: fs,
        now: NOW,
        persist: false,
      }),
    });
    const res = await callTool(ctx, 'generate_buyer_queries', {
      domain: 'acme.example',
    });
    const parsed = JSON.parse(textOf(res)) as { costCapped?: boolean };
    // Guard: if the cap did not actually trip, this test proves nothing.
    expect(parsed.costCapped).toBe(true);
    expect(proseOf(res)).toContain('Cost cap');
  });

  // Failure mode 2: the reason this block exists. A partial run's flags must
  // reach the human as prose, not sit in a JSON field the host may summarize
  // away. One prompt fails, so the engine answers 1 of 2.
  it('carries a partial run’s honesty notes into the prose', async () => {
    const fs = memFs({
      [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
      [queriesPath(STATE)]: toYaml(CACHED_PACK),
    });
    const { ctx } = workingContext({
      checkDeps: async () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch() }),
        adapters: [flakyAdapter()],
        judge: fakeJudge(),
        profileFs: fs,
        queryFs: fs,
        snapshotFs: fs,
        now: NOW,
      }),
    });
    const res = await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
    });
    const parsed = JSON.parse(textOf(res)) as { partialEngines?: unknown[] };
    // Guard: if the run is not actually partial, this test proves nothing.
    expect(parsed.partialEngines?.length).toBe(1);
    const prose = proseOf(res);
    expect(prose).toContain('Run notes');
    expect(prose).toContain('answered 1 of 2');
  });

  // A tool that errors returns ONLY the error block - no prose to slice.
  it('adds no prose block to an error result', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'check_visibility', { domain: 'bad/../x' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.content).toHaveLength(1);
  });
});

describe('check_visibility output channel', () => {
  it('returns parseable JSON as content[0].text even when a snapshot is saved', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    // The whole point: content[0].text must round-trip through JSON.parse, the
    // same way audit_store / generate_buyer_queries / get_snapshot_diff do.
    const parsed = JSON.parse(textOf(res));
    expect(parsed.schema_version).toBeTruthy();
    expect(parsed.domain).toBe('acme.example');
    expect(typeof parsed.score).toBe('number');
  });
});

describe('check_visibility engines argument', () => {
  it('restricts to a single engine passed as a bare string (never widens)', async () => {
    const { ctx, checkDeps } = workingContext({
      availableEngines: () => ['openai', 'anthropic'],
    });
    await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
      engines: 'openai',
    });
    expect(checkDeps).toHaveBeenCalledTimes(1);
    const opts = checkDeps.mock.calls[0]![0] as {
      engines?: EngineId[];
      availableEngines: EngineId[];
    };
    expect(opts.engines).toEqual(['openai']);
    expect(opts.availableEngines).toEqual(['openai']);
  });

  it('treats an empty engines array as "no preference" (all available), not an error', async () => {
    const { ctx, checkDeps } = workingContext({
      availableEngines: () => ['openai'],
    });
    const res = await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
      engines: [],
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(checkDeps).toHaveBeenCalledTimes(1);
    const opts = checkDeps.mock.calls[0]![0] as { engines?: EngineId[] };
    expect(opts.engines).toBeUndefined();
  });

  it('rejects a non-array, non-string engines value rather than querying everything', async () => {
    const { ctx, checkDeps } = workingContext({
      availableEngines: () => ['openai'],
    });
    const res = await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
      engines: { openai: true },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(checkDeps).not.toHaveBeenCalled();
  });
});

describe('check_visibility max_cost argument', () => {
  it('honors a numeric-string max_cost instead of dropping it to the higher default', async () => {
    const { ctx, checkDeps } = workingContext();
    await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
      max_cost: '0.10',
    });
    const opts = checkDeps.mock.calls[0]![0] as { maxCost?: number };
    expect(opts.maxCost).toBeCloseTo(0.1);
  });

  it('ignores a non-numeric max_cost (falls back to the default cap)', async () => {
    const { ctx, checkDeps } = workingContext();
    await callTool(ctx, 'check_visibility', {
      domain: 'acme.example',
      max_cost: 'cheap',
    });
    const opts = checkDeps.mock.calls[0]![0] as { maxCost?: number };
    expect(opts.maxCost).toBeUndefined();
  });
});

describe('generate_buyer_queries payload', () => {
  it('wraps the pack in an envelope with its own schema_version (not a mislabeled QueryPack)', async () => {
    const { ctx } = workingContext();
    const res = await callTool(ctx, 'generate_buyer_queries', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res));
    expect(parsed.schema_version).toBeTruthy();
    // The QueryPack lives intact under `pack` - the top-level object is an
    // envelope, so its extra fields (notes/savedAt) don't masquerade as pack fields.
    expect(parsed.pack).toBeDefined();
    expect(Array.isArray(parsed.pack.queries)).toBe(true);
    expect(parsed.pack.schema_version).toBeTruthy();
    expect(Array.isArray(parsed.notes)).toBe(true);
  });
});

describe('shopping_check', () => {
  /** A context whose shoppingDeps run against stubs (no network, no disk). */
  function shoppingContext(overrides: Partial<ToolContext> = {}): {
    ctx: ToolContext;
    shoppingDeps: ReturnType<typeof vi.fn>;
    fs: ReturnType<typeof memFs>;
  } {
    const { ctx, fs } = workingContext(overrides);
    const shoppingDeps = vi.fn(
      async (): Promise<Omit<RunShoppingDeps, 'confirm' | 'onProgress'>> => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch() }),
        adapters: [fakeAdapter('openai', 'parametric')],
        judge: fakeJudge(),
        profileFs: fs,
        shoppingFs: fs,
        now: NOW,
      }),
    );
    // `ctx` already carries the overrides (workingContext applied them), so the
    // shopping deps go on last and stay concretely typed.
    return { ctx: { ...ctx, shoppingDeps }, shoppingDeps, fs };
  }

  it('returns the ranking delta as JSON plus the rendered report', async () => {
    const { ctx } = shoppingContext();
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: ['Aria 2', 'Presto X'],
    });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res));
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(
      parsed.rankingDelta.map((r: { product: string }) => r.product),
    ).toEqual(['Aria 2', 'Presto X']);
    // The honesty scaffolding lives in the renderers, so the prose block must
    // ride along - a caveat only in JSON is one the host model may drop.
    const prose = proseOf(res);
    expect(prose).toContain('Your ranking vs AI:');
    expect(prose).toContain(FOOTER_CTA);
    expect(prose).not.toContain(ESC);
    // The rendered path is whatever node:path produced, so compare against the
    // same helper - normalizing here would just reintroduce the separator bug.
    expect(prose).toContain(shoppingDir(STATE));
  });

  it('accepts product objects with aliases and a descriptor', async () => {
    const { ctx } = shoppingContext();
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: [
        {
          name: 'Aria 2',
          aliases: ['Aria II'],
          descriptor: 'espresso machine',
        },
      ],
    });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.products[0]).toEqual({
      name: 'Aria 2',
      aliases: ['Aria II'],
      descriptor: 'espresso machine',
    });
  });

  it('refuses to spend when no products were named', async () => {
    const { ctx, shoppingDeps } = shoppingContext();
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('products');
    expect(shoppingDeps).not.toHaveBeenCalled();
  });

  it('rejects a mis-shaped products argument rather than guessing', async () => {
    const { ctx, shoppingDeps } = shoppingContext();
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: 42,
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(shoppingDeps).not.toHaveBeenCalled();
  });

  it('caps the product list and says so instead of silently truncating', async () => {
    const { ctx } = shoppingContext();
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: Array.from({ length: 12 }, (_, i) => `P${i + 1}`),
    });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.products).toHaveLength(10);
    // Both channels: the prose a human reads AND the JSON an agent parses.
    expect(proseOf(res)).toContain('2 further products');
    expect(parsed.notes.join(' ')).toContain('2 further products');
  });

  it('passes the product count so the cap can scale with it', async () => {
    const { ctx, shoppingDeps } = shoppingContext();
    await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: ['Aria 2', 'Presto X', 'Brew Mini'],
    });
    const opts = shoppingDeps.mock.calls[0]![0] as {
      productCount: number;
      maxCost?: number;
    };
    expect(opts.productCount).toBe(3);
    expect(opts.maxCost).toBeUndefined();
  });

  it('honors an explicit max_cost', async () => {
    const { ctx, shoppingDeps } = shoppingContext();
    await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: ['Aria 2'],
      max_cost: 0.25,
    });
    const opts = shoppingDeps.mock.calls[0]![0] as { maxCost?: number };
    expect(opts.maxCost).toBeCloseTo(0.25);
  });

  it('needs an engine key', async () => {
    const { ctx } = shoppingContext({ availableEngines: () => [] });
    const res = await callTool(ctx, 'shopping_check', {
      domain: 'acme.example',
      products: ['Aria 2'],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('API key');
  });
});
