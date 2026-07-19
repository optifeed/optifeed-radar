import { describe, it, expect, vi } from 'vitest';
import { callTool } from './tools.js';
import type { ToolContext } from './deps.js';
import type { RunCheckDeps } from '../core/run/index.js';
import { createFetcher } from '../core/fetcher/index.js';
import type { FetchLike } from '../core/fetcher/index.js';
import type { EngineAdapter } from '../core/engines/index.js';
import { profilePath, type ProfileFs } from '../core/discovery/index.js';
import { queriesPath, toYaml, type QueryFs } from '../core/queries/index.js';
import { nodeSnapshotFs, type SnapshotFs } from '../core/output/index.js';
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

function fakeJudge(): JudgeClient {
  return {
    model: 'judge-model',
    complete: async () => ({ text: '{}', costUsd: 0, model: 'judge-model' }),
  };
}

function memFs(
  seed: Record<string, string> = {},
): ProfileFs & QueryFs & SnapshotFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    files,
    async readFile(path: string) {
      return files.get(path) ?? notFound();
    },
    async writeFile(path: string, data: string) {
      files.set(path, data);
    },
    async mkdir(path: string) {
      dirs.add(path);
    },
    async readdir(path: string) {
      if (!dirs.has(path)) notFound();
      const prefix = `${path}/`;
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
    newFetcher: () => createFetcher({ fetchImpl: fakeFetch() }),
    snapshotFs: nodeSnapshotFs(),
    availableEngines: () => ['openai'],
    now: NOW,
    log: () => {},
    ...overrides,
  };
  return { ctx, checkDeps, fs };
}

function textOf(res: { content: { text: string }[] }): string {
  return res.content[0]!.text;
}

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
