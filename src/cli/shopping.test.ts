import { afterEach, describe, expect, it } from 'vitest';
import { createFetcher, type FetchLike } from '../core/fetcher/index.js';
import type { EngineAdapter } from '../core/engines/index.js';
import { profilePath, type ProfileFs } from '../core/discovery/index.js';
import type { ShoppingFs } from '../core/shopping/index.js';
import type { RunShoppingDeps } from '../core/run/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type JudgeClient,
} from '../core/types.js';
import { buildProgram } from './index.js';
import { defaultShoppingDeps } from './shopping.js';
import type { Runtime } from './runtime.js';

const STATE = '/proj/.optifeed/acme.example';
const NOW = (): string => '2026-07-23T00:00:00.000Z';

function res(body: string, status = 200) {
  return {
    status,
    headers: { get: (): string => 'text/html' },
    text: async (): Promise<string> => body,
  };
}
const fakeFetch: FetchLike = async () =>
  res('<html><head><title>Acme</title></head></html>');

function adapter(id: EngineId): EngineAdapter {
  return {
    id,
    kind: 'parametric',
    model: `${id}-model`,
    available: () => true,
    ask: async (prompt): Promise<EngineAnswer> => ({
      engine: id,
      kind: 'parametric',
      prompt,
      text: '1. **Aria 2** - quiet and compact\n2. **Breville Bambino Plus**',
      model: `${id}-model`,
      costUsd: 0.0001,
      ts: NOW(),
    }),
  };
}

const judge: JudgeClient = {
  model: 'judge-model',
  complete: async () => ({ text: '{}', costUsd: 0, model: 'judge-model' }),
};

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  category: 'home espresso machines',
  competitors: ['Breville'],
};

function normKey(p: string): string {
  return p.split('\\').join('/');
}

function memFs(seed: Record<string, string> = {}): ProfileFs & ShoppingFs {
  const files = new Map(Object.entries(seed).map(([k, v]) => [normKey(k), v]));
  const dirs = new Set<string>();
  const nf = (): never => {
    const e = new Error('ENOENT') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    throw e;
  };
  return {
    async readFile(p: string) {
      return files.get(normKey(p)) ?? nf();
    },
    async writeFile(p: string, d: string) {
      files.set(normKey(p), d);
    },
    async mkdir(p: string) {
      dirs.add(normKey(p));
    },
    async readdir(p: string) {
      const dir = normKey(p);
      if (!dirs.has(dir)) nf();
      return [...files.keys()]
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1));
    },
  };
}

function testRuntime(
  over: Partial<Runtime> = {},
  seed: Record<string, string> = {},
): Runtime & {
  output: string[];
  errors: string[];
  reports: Map<string, string>;
} {
  const output: string[] = [];
  const errors: string[] = [];
  const reports = new Map<string, string>();
  const fs = memFs({ [profilePath(STATE)]: JSON.stringify(PROFILE), ...seed });
  const shoppingDeps = (): RunShoppingDeps => ({
    fetcher: createFetcher({ fetchImpl: fakeFetch }),
    adapters: [adapter('openai')],
    judge,
    profileFs: fs,
    shoppingFs: fs,
    now: NOW,
  });
  return {
    output,
    errors,
    reports,
    out: (s) => output.push(s),
    err: (s) => errors.push(s),
    // A key is present so the command gets past the no-key gate; the adapters
    // are injected, so nothing reaches the network.
    env: { OPENAI_API_KEY: 'sk-test' },
    cwd: '/proj',
    homeDir: '/home',
    isTTY: false,
    isProjectWritable: true,
    now: NOW,
    writeFile: async (p, d) => {
      reports.set(p, d);
    },
    fetcher: createFetcher({ fetchImpl: fakeFetch }),
    snapshotFs: memFs(),
    queryFs: memFs(),
    shoppingDeps,
    ...over,
  };
}

function run(rt: Runtime, args: string[]): Promise<unknown> {
  return buildProgram(rt).parseAsync(args, { from: 'user' });
}

afterEach(() => {
  process.exitCode = 0;
});

describe('shopping command', () => {
  it('runs the named products and leads with the ranking delta', async () => {
    const rt = testRuntime();
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2, Presto X',
      '--yes',
    ]);

    const out = rt.output.join('');
    expect(out).toContain('Your ranking vs AI:');
    expect(out).toContain('Aria 2');
    expect(out).toContain('Presto X');
    expect(process.exitCode).toBeFalsy();
  });

  it('prints a pure JSON envelope under --json', async () => {
    const rt = testRuntime();
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2',
      '--yes',
      '--json',
    ]);

    const parsed = JSON.parse(rt.output.join('')) as {
      schema_version: string;
      rankingDelta: unknown[];
    };
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.rankingDelta).toHaveLength(1);
  });

  it('reads a products file', async () => {
    const rt = testRuntime(
      {},
      {
        '/proj/products.yml':
          'products:\n  - name: Aria 2\n    descriptor: quiet espresso machine\n',
      },
    );
    await run(rt, [
      'shopping',
      'acme.example',
      '--products-file',
      '/proj/products.yml',
      '--yes',
    ]);
    expect(rt.output.join('')).toContain('Aria 2');
  });

  it('errors when neither product flag is given', async () => {
    const rt = testRuntime();
    await run(rt, ['shopping', 'acme.example', '--yes']);
    expect(rt.errors.join('')).toContain('--products');
    expect(rt.errors.join('')).toContain('--products-file');
    expect(process.exitCode).toBe(1);
  });

  it('errors when both product flags are given', async () => {
    const rt = testRuntime();
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2',
      '--products-file',
      'products.yml',
      '--yes',
    ]);
    expect(rt.errors.join('')).toContain('not both');
    expect(process.exitCode).toBe(1);
  });

  it('explains an unusable products file instead of crashing', async () => {
    const rt = testRuntime({}, { '/proj/products.yml': 'products: [oops' });
    await run(rt, [
      'shopping',
      'acme.example',
      '--products-file',
      '/proj/products.yml',
      '--yes',
    ]);
    expect(rt.errors.join('')).toContain('product list');
    expect(process.exitCode).toBe(1);
  });

  it('writes the HTML report when asked', async () => {
    const rt = testRuntime();
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2',
      '--yes',
      '--report',
      'shop.html',
    ]);
    const html = rt.reports.get('shop.html') ?? '';
    expect(html).toContain('Shopping Visibility Report');
    expect(rt.output.join('')).toContain('shop.html');
  });

  it('needs at least one engine key', async () => {
    const rt = testRuntime({ env: {} });
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2',
      '--yes',
    ]);
    expect(rt.errors.join('')).toContain('API key');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a stray positional argument before spending', async () => {
    const rt = testRuntime();
    await run(rt, ['shopping', 'acme.example', 'products.yml', '--yes']);
    expect(rt.errors.join('')).toContain('Unexpected extra argument');
    expect(process.exitCode).toBe(1);
    expect(rt.output.join('')).toBe('');
  });

  it('reports the abort AND why, so the user can act on it', async () => {
    const rt = testRuntime();
    await run(rt, ['shopping', 'acme.example', '--products', 'Aria 2']);
    const said = rt.output.join('') + rt.errors.join('');
    expect(said).toContain('Aborted');
    // The note names the fix; swallowing it leaves the user with no next step.
    expect(said).toContain('yes');
  });

  it('puts the run notes in the JSON envelope, not only on stderr', async () => {
    const rt = testRuntime();
    await run(rt, [
      'shopping',
      'acme.example',
      '--products',
      'Aria 2, aria 2',
      '--yes',
      '--json',
    ]);
    const parsed = JSON.parse(rt.output.join('')) as { notes: string[] };
    expect(parsed.notes.join(' ').toLowerCase()).toContain('duplicate');
  });
});

describe('defaultShoppingDeps', () => {
  it('quotes products, prompts and engines before spending, and declines off a TTY', async () => {
    const rt = testRuntime({ isTTY: false });
    const deps = await defaultShoppingDeps(rt, {}, ['openai']);

    const proceed = await deps.confirm!({
      nPrompts: 8,
      engines: ['openai'],
      nProducts: 2,
    });

    expect(proceed).toBe(false);
    const said = rt.errors.join('');
    expect(said).toContain('2 products');
    expect(said).toContain('8 prompts');
    expect(said).toContain('--yes');
    // Prose never touches stdout, so `--json` output stays parseable.
    expect(rt.output.join('')).toBe('');
  });

  it('builds adapters for every engine so keyless ones surface as skipped', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    const deps = await defaultShoppingDeps(rt, {}, ['openai']);
    expect(deps.adapters).toHaveLength(4);
    expect(deps.adapters!.filter((a) => !a.available())).toHaveLength(3);
  });
});
