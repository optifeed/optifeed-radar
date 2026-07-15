import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
  type QueryPack,
} from '../types.js';
import { queriesPath, toYaml, type QueryFs } from './persist.js';
import { resolveQueries } from './resolve.js';

const AT = '2026-07-15T00:00:00.000Z';

function profile(): BrandProfile {
  return {
    schema_version: SCHEMA_VERSION,
    domain: 'acme.example',
    brand: 'Acme Rockets',
    aliases: [],
    category: 'model rockets',
    competitors: ['Estes'],
  };
}

const JUDGE_ANSWER = JSON.stringify({
  'best-of': ['Best model rocket kits?'],
  comparison: ['How do kit brands compare?'],
  problem: ['Why does an engine misfire?'],
  trust: ['Is this brand reputable?'],
});

function judge(text = JUDGE_ANSWER): JudgeClient & { calls: number } {
  return {
    calls: 0,
    model: 'gpt-4o-mini',
    async complete() {
      this.calls += 1;
      return { text, costUsd: 0.001, model: 'gpt-4o-mini' };
    },
  };
}

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: QueryFs = {
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async mkdir() {},
  };
  return { fs, files };
}

describe('resolveQueries', () => {
  it('loads an explicit --queries file without generating', async () => {
    const custom: QueryPack = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      queries: [{ id: 'q1', intent: 'best-of', prompt: 'Custom prompt?' }],
    };
    const { fs } = memFs({ '/custom/pack.yml': toYaml(custom) });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', queriesFile: '/custom/pack.yml' },
    );

    expect(result.fromFile).toBe(true);
    expect(result.pack).toEqual(custom);
    expect(j.calls).toBe(0);
  });

  it('reuses a hand-edited queries.yml on rerun (no regenerate)', async () => {
    const edited: QueryPack = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      generatedAt: AT,
      queries: [
        { id: 'q1', intent: 'best-of', prompt: 'My own hand-written prompt?' },
      ],
    };
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(edited) });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.fromCache).toBe(true);
    expect(result.pack).toEqual(edited); // edits survive
    expect(j.calls).toBe(0);
  });

  it('generates and persists a pack when none exists', async () => {
    const { fs, files } = memFs();
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 4 },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.pack.queries).toHaveLength(4);
    expect(result.path).toBe(queriesPath('/state'));
    expect(files.has(queriesPath('/state'))).toBe(true);
    expect(j.calls).toBe(1);
  });

  it('--regenerate overwrites an existing pack', async () => {
    const old: QueryPack = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      queries: [{ id: 'q1', intent: 'best-of', prompt: 'Old prompt?' }],
    };
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(old) });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', regenerate: true, count: 4 },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.pack.queries).toHaveLength(4);
    expect(result.pack.queries.map((q) => q.prompt)).not.toContain(
      'Old prompt?',
    );
    expect(j.calls).toBe(1);
  });
});
