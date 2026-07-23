import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  createFetcher,
  type FetchLike,
  type Fetcher,
} from '../fetcher/index.js';
import type { EngineAdapter } from '../engines/index.js';
import { profilePath, type ProfileFs } from '../discovery/index.js';
import type { ShoppingFs } from '../shopping/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
} from '../types.js';
import { runShopping } from './shopping.js';

const STATE = '/state';
const NOW = (): string => '2026-07-23T00:00:00.000Z';

const CACHED_PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  category: 'home espresso machines',
  competitors: ['Breville'],
};

const PRODUCTS = [
  { name: 'Aria 2', descriptor: 'quiet home espresso machine' },
  { name: 'Presto X', descriptor: 'quiet home espresso machine' },
];

function res(body: string, status = 200) {
  return {
    status,
    headers: { get: (): string => 'text/html' },
    text: async (): Promise<string> => body,
  };
}

function fakeFetch(): FetchLike {
  return async () => res('<html><head><title>Acme</title></head></html>');
}

function fakeAdapter(
  id: EngineId,
  kind: EngineKind,
  opts: { text?: string; cost?: number; fail?: boolean } = {},
): EngineAdapter & { asked: string[] } {
  const asked: string[] = [];
  return {
    id,
    kind,
    asked,
    model: `${id}-model`,
    available: () => true,
    ask: async (prompt): Promise<EngineAnswer> => {
      asked.push(prompt);
      if (opts.fail) throw new Error('engine exploded');
      return {
        engine: id,
        kind,
        prompt,
        text:
          opts.text ??
          '1. **Aria 2** - quiet and compact\n2. **Breville Bambino Plus**',
        model: `${id}-model`,
        costUsd: opts.cost ?? 0.001,
        ts: NOW(),
      };
    },
  };
}

/** A judge that returns nothing usable, so prompt templates are used. */
function silentJudge(): JudgeClient {
  return {
    model: 'judge-model',
    complete: async () => ({ text: '{}', costUsd: 0, model: 'judge-model' }),
  };
}

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  const base = {
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
  return base as typeof base & ProfileFs & ShoppingFs;
}

function seededFs(extra: Record<string, string> = {}) {
  return memFs({
    [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
    ...extra,
  });
}

function deps(
  fs: ReturnType<typeof memFs>,
  adapters: EngineAdapter[],
  over: Record<string, unknown> = {},
) {
  const fetcher: Fetcher = createFetcher({ fetchImpl: fakeFetch() });
  return {
    fetcher,
    adapters,
    judge: silentJudge(),
    profileFs: fs,
    shoppingFs: fs,
    now: NOW,
    ...over,
  };
}

describe('runShopping', () => {
  it('runs both layers and leads with the ranking delta', async () => {
    const fs = seededFs();
    const openai = fakeAdapter('openai', 'parametric');

    const result = await runShopping('acme.example', deps(fs, [openai]), {
      stateDir: STATE,
      products: PRODUCTS,
      yes: true,
    });

    const env = result.envelope!;
    expect(result.aborted).toBe(false);
    expect(env.schema_version).toBe(SCHEMA_VERSION);
    expect(env.rankingDelta.map((r) => r.product)).toEqual([
      'Aria 2',
      'Presto X',
    ]);
    // Aria 2 is recommended in every answer; Presto X never is.
    expect(env.rankingDelta[0]).toMatchObject({ merchantRank: 1, aiRank: 1 });
    expect(env.rankingDelta[1]).toMatchObject({
      merchantRank: 2,
      aiRank: null,
    });
    // The absent product still gets the shelf that beat it.
    expect(env.skus[1]?.shelf.length).toBeGreaterThan(0);
    expect(env.skus[1]?.mentions).toBe(0);
    expect(env.sampling.nProducts).toBe(2);
  });

  it('asks a shared category prompt once and scores it for every product', async () => {
    const fs = seededFs();
    const openai = fakeAdapter('openai', 'parametric');

    const result = await runShopping('acme.example', deps(fs, [openai]), {
      stateDir: STATE,
      products: PRODUCTS,
      yes: true,
    });

    // Both products share a descriptor, so their template category prompts are
    // identical: asked once, scored twice.
    const unique = new Set(openai.asked);
    expect(unique.size).toBe(openai.asked.length);
    expect(openai.asked.length).toBeLessThan(8);
    const env = result.envelope!;
    expect(env.skus[0]?.answers).toBe(3);
    expect(env.skus[1]?.answers).toBe(3);
    expect(env.sampling.nRows).toBe(env.skus[0]!.answers * 2 + 2);
  });

  it('persists the run to its own directory, not to check snapshots', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      { stateDir: STATE, products: PRODUCTS, yes: true },
    );

    expect(result.savedPath).toContain('/state/shopping/');
    expect(fs.files.has(result.savedPath!)).toBe(true);
    expect([...fs.files.keys()].some((p) => p.includes('snapshots'))).toBe(
      false,
    );
  });

  it('does not write anything when persistence is off', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      { stateDir: STATE, products: PRODUCTS, yes: true, persist: false },
    );
    expect(result.savedPath).toBeUndefined();
    expect([...fs.files.keys()]).toEqual([profilePath(STATE)]);
  });

  it('reads the product list from a file when given a path', async () => {
    const fs = seededFs({
      '/products.yml':
        'products:\n  - name: Aria 2\n    descriptor: espresso machine\n',
    });
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      { stateDir: STATE, productsFile: '/products.yml', yes: true },
    );
    expect(result.envelope?.products).toEqual([
      { name: 'Aria 2', descriptor: 'espresso machine' },
    ]);
  });

  it('aborts before spending when nothing confirmed the cost', async () => {
    const fs = seededFs();
    const openai = fakeAdapter('openai', 'parametric');

    const result = await runShopping('acme.example', deps(fs, [openai]), {
      stateDir: STATE,
      products: PRODUCTS,
    });

    expect(result.aborted).toBe(true);
    expect(result.envelope).toBeUndefined();
    expect(openai.asked).toEqual([]);
    expect(result.notes.join(' ')).toContain('confirmation');
  });

  it('tells the confirm gate how many products and prompts it will run', async () => {
    const fs = seededFs();
    let seen: { nProducts?: number; nPrompts: number } | undefined;

    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')], {
        confirm: async (ctx: { nProducts?: number; nPrompts: number }) => {
          seen = ctx;
          return false;
        },
      }),
      { stateDir: STATE, products: PRODUCTS },
    );

    expect(result.aborted).toBe(true);
    expect(seen?.nProducts).toBe(2);
    expect(seen?.nPrompts).toBeGreaterThan(0);
  });

  it('returns a partial run flagged cost-capped rather than throwing', async () => {
    const fs = seededFs();
    const guard = new CostGuard({ maxCostUsd: 0.0005 });
    const openai = fakeAdapter('openai', 'parametric', { cost: 0.001 });

    const result = await runShopping(
      'acme.example',
      deps(fs, [openai], { guard }),
      { stateDir: STATE, products: PRODUCTS, yes: true },
    );

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.costCapped).toBe(true);
    expect(openai.asked.length).toBeLessThan(6);
  });

  it('keeps going when an engine fails completely', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [
        fakeAdapter('openai', 'parametric'),
        fakeAdapter('gemini', 'parametric', { fail: true }),
      ]),
      { stateDir: STATE, products: PRODUCTS, yes: true },
    );

    const env = result.envelope!;
    expect(env.skippedEngines?.[0]?.engine).toBe('gemini');
    expect(env.skus[0]?.mentions).toBeGreaterThan(0);
  });

  it('reports what the run spent, including setup', async () => {
    const fs = seededFs();
    const guard = new CostGuard();
    guard.record(0.02, 'setup');

    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric', { cost: 0.01 })], {
        guard,
      }),
      { stateDir: STATE, products: [PRODUCTS[0]!], yes: true },
    );

    expect(result.envelope?.spend?.setupUsd).toBeCloseTo(0.02, 10);
    expect(result.envelope?.spend?.mainUsd).toBeGreaterThan(0);
    expect(result.spend?.totalUsd).toBeGreaterThan(0.02);
  });

  it('carries the product-list notes into the run', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      {
        stateDir: STATE,
        products: [PRODUCTS[0]!, { name: 'aria 2' }],
        yes: true,
      },
    );
    expect(result.notes.join(' ').toLowerCase()).toContain('duplicate');
    expect(result.envelope?.products).toHaveLength(1);
  });
});
