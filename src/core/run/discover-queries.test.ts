import { describe, it, expect } from 'vitest';
import { discoverAndBuildQueries } from './discover-queries.js';
import type { ProgressEvent } from './check.js';
import { CostGuard } from '../costs.js';
import { createFetcher } from '../fetcher/index.js';
import type { FetchLike } from '../fetcher/index.js';
import { profilePath, type ProfileFs } from '../discovery/index.js';
import { queriesPath, toYaml, type QueryFs } from '../queries/index.js';
import { SCHEMA_VERSION, type BrandProfile, type QueryPack } from '../types.js';

const STATE = '/state';
const NOW = (): string => '2026-07-19T00:00:00.000Z';

const CACHED_PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme',
  aliases: [],
  category: 'widgets',
  competitors: ['Globex'],
  sources: { brand: 'user' },
};

const CACHED_PACK: QueryPack = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  queries: [{ id: 'q1', intent: 'best-of', prompt: 'best widgets brand?' }],
};

function fakeFetch(): FetchLike {
  return async () => ({
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () =>
      '<html><head><title>Acme</title></head><body>widgets</body></html>',
  });
}

function memFs(seed: Record<string, string>): ProfileFs & QueryFs {
  const files = new Map(Object.entries(seed));
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    readFile: async (p: string) => files.get(p) ?? notFound(),
    writeFile: async () => {},
    mkdir: async () => {},
  };
}

describe('discoverAndBuildQueries', () => {
  it('returns the profile, pack and notes, and emits discovery/queries progress in order', async () => {
    const fs = memFs({
      [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE),
      [queriesPath(STATE)]: toYaml(CACHED_PACK),
    });
    const events: ProgressEvent[] = [];
    const result = await discoverAndBuildQueries(
      'acme.example',
      {
        fetcher: createFetcher({ fetchImpl: fakeFetch() }),
        guard: new CostGuard(),
        profileFs: fs,
        queryFs: fs,
        now: NOW,
      },
      { stateDir: STATE, persist: false },
      (e) => events.push(e),
    );

    expect(result.profile.brand).toBe('Acme');
    expect(result.pack.queries.length).toBeGreaterThan(0);
    expect(Array.isArray(result.notes)).toBe(true);

    // The caller (runCheck) emits discovery-start; the helper owns the rest.
    expect(events.map((e) => e.kind)).toEqual([
      'discovery-done',
      'queries-start',
      'queries-done',
    ]);
    expect(events[0]).toMatchObject({ brand: 'Acme' });
    expect(events[2]).toMatchObject({ prompts: ['best widgets brand?'] });
  });
});
