import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  createFetcher,
  type FetchLike,
  type Fetcher,
} from '../fetcher/index.js';
import type { EngineAdapter } from '../engines/index.js';
import { profilePath, type ProfileFs } from '../discovery/index.js';
import { shoppingDir, type ShoppingFs } from '../shopping/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
} from '../types.js';
import { isAbortFailure, type AbortReason } from './check.js';
import {
  runShopping,
  type RunShoppingAborted,
  type RunShoppingCompleted,
  type RunShoppingResult,
} from './shopping.js';

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
      // Keys come from node:path `join`, so the prefix has to use the same
      // separator the platform produced (Windows CI).
      const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
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

/**
 * Narrow a result to its completed arm, the way `check.test.ts` does. An
 * `expect(result.aborted).toBe(false)` asserts at runtime but does not narrow
 * the union for the compiler, so tests that read the envelope come through here
 * rather than through a `!` - and an unexpected abort fails loudly, naming its
 * reason, instead of surfacing as "cannot read property of undefined".
 */
function completed(result: RunShoppingResult): RunShoppingCompleted {
  if (result.aborted) {
    throw new Error(
      `expected a completed run, got an abort: ${result.abortReason}`,
    );
  }
  return result;
}

/** The mirror of {@link completed}, for the abort paths. */
function aborted(result: RunShoppingResult): RunShoppingAborted {
  if (!result.aborted) {
    throw new Error('expected an aborted run, got a completed one');
  }
  return result;
}

describe('runShopping', () => {
  it('runs both layers and leads with the product engines ignored', async () => {
    const fs = seededFs();
    const openai = fakeAdapter('openai', 'parametric');

    const result = await runShopping('acme.example', deps(fs, [openai]), {
      stateDir: STATE,
      products: PRODUCTS,
      yes: true,
    });

    const env = completed(result).envelope;
    expect(result.aborted).toBe(false);
    expect(env.schema_version).toBe(SCHEMA_VERSION);
    // Aria 2 is recommended in every answer; Presto X never is. The absent
    // product leads regardless of the order they were listed in.
    expect(env.skus.map((s) => s.product)).toEqual(['Presto X', 'Aria 2']);
    expect(env.skus[0]).toMatchObject({ product: 'Presto X', mentions: 0 });
    // The absent product still gets the shelf that beat it.
    expect(env.skus[0]?.shelf.length).toBeGreaterThan(0);
    expect(env.skus[1]?.mentions).toBeGreaterThan(0);
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
    const env = completed(result).envelope;
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

    // Built with node:path, so compare against the module's own directory
    // helper rather than a hardcoded "/" path (Windows CI).
    expect(completed(result).savedPath?.startsWith(shoppingDir(STATE))).toBe(
      true,
    );
    expect(fs.files.has(completed(result).savedPath!)).toBe(true);
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
    expect(completed(result).savedPath).toBeUndefined();
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
    expect(completed(result).envelope.products).toEqual([
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
    // The envelope is gone from this arm by construction (the union carries it
    // only on the completed arm), so the assertion is that nothing from a
    // completed run rides along.
    expect(result).not.toHaveProperty('envelope');
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

  // The runtime half of the guarantee the union makes at compile time, and the
  // same table `check.test.ts` keeps: an aborted shopping run ALWAYS says why,
  // and never carries the fields of a run that reached the engines. Before
  // this, both abort returns were an untagged `{ aborted: true }`, so the CLI
  // could not tell a user's decline from a missing confirm handler and exited 0
  // for both - a run that measured nothing read to CI as a pass.
  //
  // Only the two reasons shopping can PRODUCE are keyed here. `no-prompts` is
  // shared with `check` but unreachable in this pipeline (see the comment on
  // the gate in shopping.ts), so demanding it would assert a path that does not
  // exist.
  it('tags every abort path with a reason and no run fields', async () => {
    const byReason: Record<
      Exclude<AbortReason, 'no-prompts'>,
      { result: RunShoppingResult; failure: boolean }
    > = {
      declined: {
        result: await runShopping(
          'acme.example',
          deps(seededFs(), [fakeAdapter('openai', 'parametric')], {
            confirm: async () => false,
          }),
          { stateDir: STATE, products: PRODUCTS },
        ),
        failure: false, // the user's own choice
      },
      unconfirmed: {
        result: await runShopping(
          'acme.example',
          deps(seededFs(), [fakeAdapter('openai', 'parametric')]), // no confirm, no yes
          { stateDir: STATE, products: PRODUCTS },
        ),
        failure: true,
      },
    };

    for (const [reason, { result, failure }] of Object.entries(byReason)) {
      const stopped = aborted(result);
      expect(stopped.abortReason, reason).toBe(reason);
      // The SHARED predicate, not a local copy of the rule: a decline is not a
      // failure, everything else is.
      expect(isAbortFailure(stopped.abortReason), reason).toBe(failure);
      // Nothing from the completed arm rides along: no envelope to relaunder an
      // unmeasured run as a result, no saved path naming a file never written.
      expect(result, reason).not.toHaveProperty('envelope');
      expect(result, reason).not.toHaveProperty('savedPath');
      // And the human-readable why, which the union cannot enforce.
      expect(stopped.notes.length, reason).toBeGreaterThan(0);
    }
  });

  // The zero-prompt abort `check` needs has no counterpart here, and this test
  // is why: the reputation layer is templatable from the product NAME alone,
  // and `resolveProducts` throws rather than returning an empty list, so the
  // gate can never be reached with nothing to ask. If that ever changes, this
  // fails and the guard becomes real.
  it('always has at least one prompt to ask, even with no judge and no descriptors', async () => {
    // A cached profile with NO category, so a product with no descriptor has no
    // subject at all and its visibility layer drops out entirely - the
    // reputation layer is all that is left.
    const fs = seededFs({
      [profilePath(STATE)]: JSON.stringify({
        ...CACHED_PROFILE,
        category: undefined,
      }),
    });
    let seenPrompts = 0;
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')], {
        judge: undefined,
        confirm: async (ctx: { nPrompts: number }) => {
          seenPrompts = ctx.nPrompts;
          return false;
        },
      }),
      { stateDir: STATE, products: [{ name: 'Zephyr Q9' }] },
    );

    const stopped = aborted(result);
    expect(stopped.abortReason).toBe('declined');
    // Exactly one - the single templated reputation prompt. Asserting the count
    // rather than ">= 1" proves the visibility layer really did drop out, so
    // the test is measuring the worst case it claims to.
    expect(seenPrompts).toBe(1);
    expect(stopped.notes.join(' ')).toContain('No category questions');
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

    expect(completed(result).envelope).toBeDefined();
    expect(completed(result).envelope.costCapped).toBe(true);
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

    const env = completed(result).envelope;
    expect(env.skippedEngines?.[0]?.engine).toBe('gemini');
    // Keyed by name, not position: the envelope sorts by what engines did.
    const aria = env.skus.find((s) => s.product === 'Aria 2');
    expect(aria?.mentions).toBeGreaterThan(0);
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

    expect(completed(result).envelope.spend?.setupUsd).toBeCloseTo(0.02, 10);
    expect(completed(result).envelope.spend?.mainUsd).toBeGreaterThan(0);
    expect(result.spend?.totalUsd).toBeGreaterThan(0.02);
  });

  it('records how many category questions each product asked for', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      { stateDir: STATE, products: PRODUCTS, yes: true },
    );
    const env = completed(result).envelope;
    expect(env.skus[0]?.categoryPrompts).toBe(3);
  });

  // A capped run leaves the questions written but unanswered. Without the
  // requested count the report blamed the merchant's product list for it.
  it('keeps a capped product measured, with no answers', async () => {
    const fs = seededFs();
    const guard = new CostGuard({ maxCostUsd: 0.0005 });
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric', { cost: 0.001 })], {
        guard,
      }),
      { stateDir: STATE, products: PRODUCTS, yes: true },
    );
    const env = completed(result).envelope;
    expect(env.costCapped).toBe(true);
    for (const sku of env.skus) expect(sku.categoryPrompts).toBeGreaterThan(0);
    const unanswered = env.skus.filter((s) => s.answers === 0);
    expect(unanswered.length).toBeGreaterThan(0);
    expect(unanswered.every((s) => s.categoryPrompts > 0)).toBe(true);
  });

  it('carries the run notes on the envelope, not only to the caller', async () => {
    const fs = seededFs();
    const result = await runShopping(
      'acme.example',
      deps(fs, [fakeAdapter('openai', 'parametric')]),
      {
        stateDir: STATE,
        // 11 products: one over the cap, so a note is generated.
        products: Array.from({ length: 11 }, (_, i) => ({
          name: `P${i + 1}`,
          descriptor: 'espresso machine',
        })),
        yes: true,
      },
    );
    const env = completed(result).envelope;
    // The JSON channel must carry what the terminal says: an agent reading 10
    // products cannot otherwise tell that an 11th was dropped.
    expect(env.notes.join(' ')).toContain('1 further product');
    expect(env.notes).toEqual(result.notes);
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
    expect(completed(result).envelope.products).toHaveLength(1);
  });
});
