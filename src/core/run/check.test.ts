import { describe, expect, it, vi } from 'vitest';
import {
  CostGuard,
  ESTIMATE_ASSUMPTIONS,
  MODEL_PRICING,
  costOfCall,
} from '../costs.js';
import { createFetcher } from '../fetcher/index.js';
import type { FetchLike, Fetcher } from '../fetcher/index.js';
import type { EngineAdapter } from '../engines/index.js';
import { profilePath, type ProfileFs } from '../discovery/index.js';
import { queriesPath, toYaml, type QueryFs } from '../queries/index.js';
import type { SnapshotFs } from '../output/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
  type QueryPack,
} from '../types.js';
import { runCheck, type ProgressEvent } from './check.js';

const STATE = '/state';
const NOW = () => '2026-07-15T00:00:00.000Z';

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

/** Minimal HttpResponse the injected fetch returns (no global Response needed). */
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

/** A fetch router good enough for the audit gather (robots/home/sitemap/llms). */
function fakeFetch(): FetchLike {
  const HOME =
    '<html><head><title>Acme</title><meta property="og:site_name" content="Acme"></head><body>Acme widgets</body></html>';
  return async (url) => {
    const u = url.replace(/\/$/, '');
    if (u.endsWith('robots.txt')) return res('User-agent: *\nAllow: /', 200);
    if (u.endsWith('llms.txt')) return res('not found', 404);
    if (u.endsWith('llms-full.txt')) return res('not found', 404);
    if (u.endsWith('sitemap.xml')) return res('not found', 404);
    return res(HOME, 200);
  };
}

function fakeAdapter(
  id: EngineId,
  kind: EngineKind,
  opts: {
    available?: boolean;
    cost?: number;
    text?: (p: string) => string;
    model?: string;
  } = {},
): EngineAdapter {
  const model = opts.model ?? `${id}-model`;
  return {
    id,
    kind,
    model,
    available: () => opts.available ?? true,
    ask: async (prompt): Promise<EngineAnswer> => ({
      engine: id,
      kind,
      prompt,
      text: opts.text?.(prompt) ?? 'Acme is a great widget brand.',
      model,
      costUsd: opts.cost ?? 0.001,
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

/** In-memory fs shared by profile/query/snapshot roles. */
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
  return base as typeof base & ProfileFs & QueryFs & SnapshotFs;
}

/** A state dir pre-seeded with a cached profile + query pack (no LLM setup needed). */
function seededFs() {
  return memFs({
    [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
    [queriesPath(STATE)]: toYaml(CACHED_PACK),
  });
}

function baseDeps(fs: ReturnType<typeof memFs>, fetcher: Fetcher) {
  return {
    fetcher,
    adapters: [
      fakeAdapter('openai', 'parametric'),
      fakeAdapter('perplexity', 'grounded'),
    ],
    judge: fakeJudge(),
    profileFs: fs,
    queryFs: fs,
    snapshotFs: fs,
    now: NOW,
  };
}

describe('runCheck spend reporting', () => {
  // Before this, a run billed real money and reported it NOWHERE: the figure
  // was only recoverable by summing costUsd across answers in the snapshot
  // JSON, and --yes (the documented agent/CI path) skips the confirm gate that
  // shows the estimate, so those runs saw no cost at all, before or after.
  it('reports what the run actually spent, from the guard', async () => {
    const fs = seededFs();
    const guard = new CostGuard();
    // Setup spend the guard sees but no ANSWER carries: this is exactly what
    // summing answers would lose.
    guard.record(0.02, 'setup');

    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        adapters: [fakeAdapter('openai', 'parametric', { cost: 0.01 })],
        guard,
      },
      { stateDir: STATE, yes: true },
    );

    const env = result.envelope!;
    expect(env.spend).toBeDefined();
    const answersTotal = env.answers.reduce((s, a) => s + a.costUsd, 0);
    expect(env.spend!.mainUsd).toBeCloseTo(answersTotal, 10);
    expect(env.spend!.setupUsd).toBeCloseTo(0.02, 10);
    // The headline figure must exceed the answers alone, or setup spend
    // (discovery, query generation, the scoring judge) is being hidden.
    expect(env.spend!.totalUsd).toBeGreaterThan(answersTotal);
    expect(env.spend!.totalUsd).toBeCloseTo(answersTotal + 0.02, 10);
  });

  // Discovery and query generation run BEFORE the confirm gate, so declining
  // still spent real money. "Aborted, no engines were queried" is true but
  // incomplete: the setup phase already billed, and a user who declined
  // precisely to avoid spending deserves to know it was not free.
  it('reports setup spend even when the run is aborted at the confirm gate', async () => {
    const fs = seededFs();
    const guard = new CostGuard();
    guard.record(0.02, 'setup');

    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        guard,
        confirm: async () => false,
      },
      { stateDir: STATE },
    );

    expect(result.aborted).toBe(true);
    expect(result.envelope).toBeUndefined();
    expect(result.spend?.setupUsd).toBeCloseTo(0.02, 10);
    expect(result.spend?.totalUsd).toBeCloseTo(0.02, 10);
  });

  it('reports setup spend when aborting for a missing confirm handler', async () => {
    const fs = seededFs();
    const guard = new CostGuard();
    guard.record(0.02, 'setup');
    const result = await runCheck(
      'acme.example',
      { ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })), guard },
      { stateDir: STATE }, // no yes, no confirm
    );
    expect(result.aborted).toBe(true);
    expect(result.spend?.totalUsd).toBeCloseTo(0.02, 10);
  });

  // The field was populated on both ABORT paths but dropped from the success
  // return, so `result.spend` existed exactly for runs that spent almost
  // nothing and was undefined for the run that actually spent. A consumer
  // branching on `result.spend !== undefined` read a completed run as uncosted.
  it('reports spend on the success return, not only on aborts', async () => {
    const fs = seededFs();
    const guard = new CostGuard();
    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        adapters: [fakeAdapter('openai', 'parametric', { cost: 0.01 })],
        guard,
      },
      { stateDir: STATE, yes: true },
    );

    expect(result.aborted).toBe(false);
    expect(result.spend).toBeDefined();
    expect(result.spend).toEqual(result.envelope!.spend);
  });

  it('still reports spend on a cost-capped partial run', async () => {
    // A capped run spent real money before it stopped; reporting nothing here
    // would hide the exact spend a user hit a cap trying to control.
    const fs = seededFs();
    const guard = new CostGuard({ maxCostUsd: 0.005 });
    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        adapters: [fakeAdapter('openai', 'parametric', { cost: 0.004 })],
        guard,
      },
      { stateDir: STATE, yes: true },
    );
    expect(result.envelope!.spend).toBeDefined();
    expect(result.envelope!.costCapped).toBe(true);
  });
});

describe('runCheck end to end (all mocked)', () => {
  it('produces a full envelope with score, audit findings, and a snapshot', async () => {
    const fs = seededFs();
    const fetcher = createFetcher({ fetchImpl: fakeFetch() });
    const result = await runCheck('acme.example', baseDeps(fs, fetcher), {
      stateDir: STATE,
      yes: true,
    });

    expect(result.aborted).toBe(false);
    const env = result.envelope;
    expect(env).toBeDefined();
    expect(env?.domain).toBe('acme.example');
    expect(env?.profile.brand).toBe('Acme');
    expect(typeof env?.score).toBe('number');
    expect(env?.engines.length).toBe(2);
    // Audit findings (M3) flow in; llms.txt was 404 so there is at least one.
    expect(env?.findings.length).toBeGreaterThan(0);
    expect(env?.answers.length).toBe(4); // 2 prompts x 2 engines
    // Clean run: no honesty flags.
    expect(env?.costCapped).toBeUndefined();
    expect(env?.skippedEngines).toBeUndefined();
    expect(env?.degraded).toBeUndefined();
    // Snapshot written under the state dir.
    expect(result.snapshotPath).toContain('snapshots');
    expect(fs.files.has(result.snapshotPath!)).toBe(true);
  });

  it('emits ordered progress events across every phase (rule #1: data, not render)', async () => {
    const fs = seededFs();
    const fetcher = createFetcher({ fetchImpl: fakeFetch() });
    const events: ProgressEvent[] = [];

    await runCheck(
      'acme.example',
      { ...baseDeps(fs, fetcher), onProgress: (e) => events.push(e) },
      { stateDir: STATE, yes: true },
    );

    const kinds = events.map((e) => e.kind);
    // Phase order, ignoring the repeated per-answer ticks.
    expect(kinds.filter((k) => k !== 'ask-answered')).toEqual([
      'discovery-start',
      'discovery-done',
      'queries-start',
      'queries-done',
      'ask-start',
      'ask-done',
      'scoring-start',
      'scoring-done',
    ]);

    // 2 prompts x 2 engines = 4 individual asks; the counter advances 1..4.
    const start = events.find((e) => e.kind === 'ask-start');
    expect(start).toEqual({ kind: 'ask-start', total: 4 });
    const ticks = events.filter((e) => e.kind === 'ask-answered');
    expect(ticks).toHaveLength(4);
    expect(ticks.at(-1)).toEqual({ kind: 'ask-answered', done: 4, total: 4 });

    // Discovery/queries carry what the renderer prints.
    expect(events.find((e) => e.kind === 'discovery-done')).toMatchObject({
      brand: 'Acme',
    });
    expect(events.find((e) => e.kind === 'queries-done')).toMatchObject({
      prompts: ['best widgets brand?', 'top widget makers?'],
    });
  });

  it('bypasses the confirmation gate under --yes', async () => {
    const fs = seededFs();
    const confirm = vi.fn(async () => true);
    const result = await runCheck(
      'acme.example',
      { ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })), confirm },
      { stateDir: STATE, yes: true },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.envelope).toBeDefined();
  });

  it('keeps branded (trust) prompts out of the score and reports reputation', async () => {
    // Pack with one unbranded (best-of) and one branded (trust) prompt.
    const pack: QueryPack = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      queries: [
        { id: 'q1', intent: 'best-of', prompt: 'best widgets brand?' },
        { id: 'q2', intent: 'trust', prompt: 'Is Acme reliable?' },
      ],
    };
    const fs = memFs({
      [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
      [queriesPath(STATE)]: toYaml(pack),
    });
    // One engine that vouches for Acme on the branded prompt.
    const adapters = [
      fakeAdapter('openai', 'parametric', {
        text: (p) =>
          p === 'Is Acme reliable?'
            ? 'Yes, Acme is very reliable and trusted.'
            : 'Acme is a great widget brand.',
      }),
    ];
    const result = await runCheck(
      'acme.example',
      { ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })), adapters },
      { stateDir: STATE, yes: true },
    );

    const env = result.envelope!;
    // Score sees only the 1 unbranded prompt (1 engine x 1 discovery prompt).
    expect(env.engines[0]!.answers).toBe(1);
    expect(env.sampling.nPrompts).toBe(1);
    // The branded prompt surfaces as reputation, not in the score.
    expect(env.reputation).toEqual({
      prompts: 1,
      answers: 1,
      positive: 1,
      neutral: 0,
      negative: 0,
    });
    // Both answers remain as evidence (nothing discarded).
    expect(env.answers).toHaveLength(2);
  });

  // The confirm gate is where a user decides whether to spend, so the number
  // it shows must price the run actually being requested. A grounded run owes
  // Google a per-search fee that dominates its cost; quoting the parametric
  // price would understate what the user is agreeing to.
  it('quotes the grounding fee in the estimate for a grounded run', async () => {
    const seen: (number | undefined)[] = [];
    const runWithMode = async (mode?: 'grounded'): Promise<void> => {
      const fs = seededFs();
      await runCheck(
        'acme.example',
        {
          ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
          adapters: [
            fakeAdapter('gemini', 'parametric', {
              model: 'gemini-flash-latest',
            }),
          ],
          // Both models must be in MODEL_PRICING or priceRun returns undefined
          // and the test would compare two blanks.
          judge: {
            model: 'gpt-5.4',
            complete: async () => ({
              text: '{}',
              costUsd: 0,
              model: 'gpt-5.4',
            }),
          },
          confirm: async (ctx) => {
            seen.push(ctx.estimate?.totalUsd);
            return false; // never spend; we only want the quote
          },
        },
        { stateDir: STATE, ...(mode ? { mode } : {}) },
      );
    };

    await runWithMode();
    await runWithMode('grounded');

    const [parametric, grounded] = seen;
    expect(parametric).toBeDefined();
    expect(grounded).toBeDefined();
    expect(grounded!).toBeGreaterThan(parametric!);
  });

  it('aborts without asking any engine when confirmation is declined', async () => {
    const fs = seededFs();
    const adapters = [fakeAdapter('openai', 'parametric')];
    const askSpy = vi.spyOn(adapters[0]!, 'ask');
    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        adapters,
        confirm: async () => false,
      },
      { stateDir: STATE },
    );
    expect(result.aborted).toBe(true);
    expect(result.envelope).toBeUndefined();
    expect(askSpy).not.toHaveBeenCalled();
    // Nothing spent, nothing persisted.
    expect(result.snapshotPath).toBeUndefined();
  });

  it('refuses to spend when there is no confirm handler and not --yes (rule #8)', async () => {
    // A seam consumer (e.g. MCP) that wires no confirm and forgets --yes must
    // NOT silently spend money; the safe default is to abort before asking.
    const fs = seededFs();
    const adapters = [fakeAdapter('openai', 'parametric')];
    const askSpy = vi.spyOn(adapters[0]!, 'ask');
    const result = await runCheck(
      'acme.example',
      { ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })), adapters },
      { stateDir: STATE }, // no yes, no confirm in deps override below
    );
    // baseDeps has no confirm; the override above keeps it absent.
    expect(result.aborted).toBe(true);
    expect(askSpy).not.toHaveBeenCalled();
    expect(result.envelope).toBeUndefined();
  });

  it('caps mid-run under --max-cost: partial envelope, costCapped, never throws', async () => {
    const fs = seededFs();
    // askAll authorizes an estimated per-call cost against the guard before each
    // ask. Price a real model so the estimate is non-zero, then set the cap so
    // the first call fits but the second trips it (single adapter, serial).
    const est = costOfCall(
      MODEL_PRICING.models['gpt-4o-mini']!,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      ESTIMATE_ASSUMPTIONS.avgOutputTokens,
    );
    const guard = new CostGuard({ maxCostUsd: est * 1.5 });
    const adapters = [
      fakeAdapter('openai', 'parametric', { model: 'gpt-4o-mini', cost: est }),
    ];
    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        adapters,
        guard,
      },
      { stateDir: STATE, yes: true, concurrency: 1 },
    );
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.costCapped).toBe(true);
    // The 2 prompts could not all get through under the cap.
    expect(result.envelope!.answers.length).toBeLessThan(2);
  });

  it('surfaces skippedEngines and degraded honesty upward (rule #6)', async () => {
    // No cached profile; brand/category flags -> degraded no-fetch path.
    const fs = memFs({ [queriesPath(STATE)]: toYaml(CACHED_PACK) });
    const adapters = [
      fakeAdapter('openai', 'parametric'),
      fakeAdapter('perplexity', 'grounded', { available: false }),
    ];
    const result = await runCheck(
      'acme.example',
      { ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })), adapters },
      { stateDir: STATE, brand: 'Acme', category: 'widgets', yes: true },
    );
    const env = result.envelope!;
    expect(env.degraded).toBe(true);
    expect(env.skippedEngines).toEqual([
      { engine: 'perplexity', reason: 'no API key' },
    ]);
  });

  it('does not persist a snapshot when persist is false', async () => {
    const fs = seededFs();
    const before = fs.files.size;
    const result = await runCheck(
      'acme.example',
      baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
      { stateDir: STATE, yes: true, persist: false },
    );
    expect(result.envelope).toBeDefined();
    expect(result.snapshotPath).toBeUndefined();
    expect(fs.files.size).toBe(before); // nothing written
  });
});
