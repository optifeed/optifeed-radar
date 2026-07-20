import { describe, it, expect, vi } from 'vitest';
import { buildCheckDeps } from './deps.js';
import { createFetcher } from '../fetcher/index.js';
import * as registry from '../engines/registry.js';
import type { EngineId } from '../types.js';

const OPENAI_ENV = { OPENAI_API_KEY: 'sk-test' } as Record<
  string,
  string | undefined
>;

describe('buildCheckDeps', () => {
  it('builds a judge, node fs, and adapters narrowed to the requested engines', async () => {
    const { deps, judgeNotice } = await buildCheckDeps({
      env: OPENAI_ENV,
      fetcher: createFetcher(),
      engines: ['openai'] as EngineId[],
      availableEngines: ['openai'] as EngineId[],
    });
    expect(deps.adapters?.map((a) => a.id)).toEqual(['openai']);
    expect(deps.judge).toBeDefined();
    expect(deps.profileFs).toBeDefined();
    expect(deps.queryFs).toBeDefined();
    expect(deps.snapshotFs).toBeDefined();
    expect(typeof judgeNotice === 'string' || judgeNotice === undefined).toBe(
      true,
    );
    expect('confirm' in deps).toBe(false);
    expect('onProgress' in deps).toBe(false);
  });

  // A judge measured to fabricate must reach the user, not sit in core. This
  // project has shipped four things that existed with no call site
  // (CostGuard.authorize, failUnder, --grounded, supportsGrounded); a quality
  // warning nobody surfaces would be the fifth.
  it('surfaces a measured-poor judge as a quality warning', async () => {
    const { judgeQualityWarning } = await buildCheckDeps({
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      fetcher: createFetcher(),
      availableEngines: ['anthropic'] as EngineId[],
    });
    expect(judgeQualityWarning).toMatch(/recall/i);
  });

  it('carries no quality warning for a measured-good judge', async () => {
    const { judgeQualityWarning } = await buildCheckDeps({
      env: OPENAI_ENV,
      fetcher: createFetcher(),
      availableEngines: ['openai'] as EngineId[],
    });
    expect(judgeQualityWarning).toBeUndefined();
  });

  it('defaults to all engines when none are requested', async () => {
    const { deps } = await buildCheckDeps({
      env: OPENAI_ENV,
      fetcher: createFetcher(),
      availableEngines: ['openai'] as EngineId[],
    });
    expect(deps.adapters?.length ?? 0).toBeGreaterThan(1);
  });

  it('does not build the full four-adapter set twice per run', async () => {
    // The judge adapter needs one engine's adapter with the resolved judge
    // model; building all four a second time just to pull out one is waste.
    const spy = vi.spyOn(registry, 'createEngineAdapters');
    await buildCheckDeps({
      env: OPENAI_ENV,
      fetcher: createFetcher(),
      availableEngines: ['openai'] as EngineId[],
    });
    // At most one full (unrestricted) build; any judge build is narrowed.
    const fullBuilds = spy.mock.calls.filter(
      ([opts]) => opts.only?.length !== 1,
    );
    expect(fullBuilds.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  it('rejects an empty availableEngines set with an honest error (no broken judge)', async () => {
    // The judge fallback used a non-null assertion on availableEngines[0]; an
    // empty set would build a judge over an undefined adapter that crashes on
    // first use. A caller that forgets the upstream guard must get a clear
    // error, not a latent crash.
    await expect(
      buildCheckDeps({
        env: OPENAI_ENV,
        fetcher: createFetcher(),
        availableEngines: [] as EngineId[],
      }),
    ).rejects.toThrow(/at least one/i);
  });

  // The judge ENGINE was reverse-looked-up by exact match against
  // DEFAULT_JUDGE_MODELS, with a silent fallback to availableEngines[0]. Two of
  // those four values changed on 2026-07-20, so ids the tool itself told users
  // to pin ("defaulting to the cheapest available (gemini-2.5-flash). Set one
  // with --judge") stopped matching and built an OPENAI adapter that posts
  // `model: "gemini-2.5-flash"` to api.openai.com - every judge call 400s with
  // a confusing cross-provider error. MODEL_PRICING deliberately keeps the
  // legacy ids so pinned runs still PRICE, which is exactly why routing must
  // keep working too.
  it('routes a pinned legacy judge model to its real provider', async () => {
    const spy = vi.spyOn(registry, 'createEngineAdapters');
    await buildCheckDeps({
      env: { OPENAI_API_KEY: 'sk-test', GOOGLE_API_KEY: 'g-test' },
      fetcher: createFetcher(),
      availableEngines: ['openai', 'gemini'] as EngineId[],
      judgeModel: 'gemini-2.5-flash',
    });

    const judgeBuild = spy.mock.calls
      .map(([opts]) => opts)
      .find((opts) => opts.only?.length === 1);
    expect(judgeBuild?.only).toEqual(['gemini']);
    expect(judgeBuild?.models).toEqual({ gemini: 'gemini-2.5-flash' });
    spy.mockRestore();
  });

  it('errors honestly on a judge model it cannot route to a provider', async () => {
    await expect(
      buildCheckDeps({
        env: OPENAI_ENV,
        fetcher: createFetcher(),
        availableEngines: ['openai'] as EngineId[],
        judgeModel: 'llama-4-70b',
      }),
    ).rejects.toThrow(/llama-4-70b/);
  });
});
