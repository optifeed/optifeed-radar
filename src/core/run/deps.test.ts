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
});
