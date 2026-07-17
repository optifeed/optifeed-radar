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

  // Live 2026-07-17 (www.do-re.com.tr): a 20-prompt pack was already cached, so
  // `check --quick` (count 8) silently ran all 20 - 2.5x the cost the flag
  // asked for, with no warning. `count` is a COST CONTROL; reusing a pack must
  // still respect it. Truncation (not regeneration) is deliberate: it spends
  // nothing and keeps the prompts stable across runs, so a diff stays valid.
  function pack(n: number, domain = 'acme.example'): QueryPack {
    return {
      schema_version: SCHEMA_VERSION,
      domain,
      generatedAt: AT,
      queries: Array.from({ length: n }, (_, i) => ({
        id: `q${i + 1}`,
        intent: 'best-of' as const,
        prompt: `Cached prompt ${i + 1}?`,
      })),
    };
  }

  it('caps a larger cached pack to count (--quick) and says so', async () => {
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(pack(20)) });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 8 },
    );

    expect(result.fromCache).toBe(true);
    expect(result.pack.queries).toHaveLength(8);
    // Deterministic + stable: the first N in file order, so reruns compare.
    expect(result.pack.queries[0]!.prompt).toBe('Cached prompt 1?');
    expect(result.pack.queries[7]!.prompt).toBe('Cached prompt 8?');
    // Never silent - the user asked for 8 and must see that 12 were dropped.
    expect(result.note).toMatch(/8 of 20/);
    expect(j.calls).toBe(0); // capping must not spend
  });

  it('leaves a cached pack alone when it already fits within count', async () => {
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(pack(5)) });

    const result = await resolveQueries(
      profile(),
      { judge: judge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 8 },
    );

    expect(result.pack.queries).toHaveLength(5);
    expect(result.note).toBeUndefined(); // nothing dropped, nothing to report
  });

  it('caps an explicit --queries file to count too', async () => {
    const { fs } = memFs({ '/custom/pack.yml': toYaml(pack(20)) });

    const result = await resolveQueries(
      profile(),
      { judge: judge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', queriesFile: '/custom/pack.yml', count: 8 },
    );

    expect(result.fromFile).toBe(true);
    expect(result.pack.queries).toHaveLength(8);
    expect(result.note).toMatch(/8 of 20/);
    // Review 2026-07-17: on the explicit-file path, step 1 returns before the
    // --regenerate check, so advising --regenerate is a dead instruction; and
    // an explicit input file is not a "saved" pack.
    expect(result.note).not.toMatch(/--regenerate/);
    expect(result.note).not.toMatch(/saved/);
  });

  it('the cached-pack note still advises --regenerate (where it actually works)', async () => {
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(pack(20)) });
    const result = await resolveQueries(
      profile(),
      { judge: judge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 8 },
    );
    expect(result.note).toMatch(/--regenerate/);
  });

  it('reuses the whole cached pack when no count is given', async () => {
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(pack(20)) });

    const result = await resolveQueries(
      profile(),
      { judge: judge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.pack.queries).toHaveLength(20);
    expect(result.note).toBeUndefined();
  });

  it('regenerates (does not abort) when the cached pack has an incompatible schema_version', async () => {
    const stale = {
      schema_version: '0.1', // from a prior, incompatible version
      domain: 'acme.example',
      generatedAt: AT,
      queries: [{ id: 'q1', intent: 'best-of', prompt: 'Old cached prompt?' }],
    };
    const { fs } = memFs({
      [queriesPath('/state')]: toYaml(stale as unknown as QueryPack),
    });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 4 },
    );

    expect(result.fromCache).toBeUndefined(); // did NOT reuse the stale cache
    expect(j.calls).toBe(1); // regenerated
  });

  it('never reuses a cached pack from a different domain (shared state dir)', async () => {
    // A flat, writable-project state dir holds another brand's queries.yml; a
    // run for THIS profile's domain must regenerate, not ask another brand's
    // buyer prompts.
    const otherPack: QueryPack = {
      schema_version: SCHEMA_VERSION,
      domain: 'figma.com',
      generatedAt: AT,
      queries: [{ id: 'q1', intent: 'best-of', prompt: 'Best design tool?' }],
    };
    const { fs } = memFs({ [queriesPath('/state')]: toYaml(otherPack) });
    const j = judge();

    const result = await resolveQueries(
      profile(),
      { judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 4 },
    );

    expect(result.fromCache).toBeUndefined(); // did NOT reuse figma's pack
    expect(result.pack.domain).toBe('acme.example');
    expect(result.pack.queries).not.toContainEqual(otherPack.queries[0]);
    expect(j.calls).toBe(1); // regenerated for this brand
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
