import { describe, it, expect } from 'vitest';
import { buildCheckDeps } from './deps.js';
import { createFetcher } from '../fetcher/index.js';
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
});
