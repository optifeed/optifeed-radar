import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type QueryPack } from '../types.js';
import { SchemaVersionError } from '../validation.js';
import {
  QueryPackError,
  loadQueryPack,
  loadQueryPackFromFile,
  parseQueryPack,
  queriesPath,
  saveQueryPack,
  toYaml,
  type QueryFs,
} from './persist.js';

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const mkdirs: string[] = [];
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
    async mkdir(path) {
      mkdirs.push(path);
    },
  };
  return { fs, files, mkdirs };
}

const PACK: QueryPack = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  generatedAt: '2026-07-15T00:00:00.000Z',
  queries: [
    { id: 'q1', intent: 'best-of', prompt: 'Best model rocket kits?' },
    { id: 'q2', intent: 'trust', prompt: 'Is Acme Rockets reputable?' },
  ],
};

describe('query pack persistence', () => {
  it('round-trips a pack through YAML', () => {
    expect(parseQueryPack(toYaml(PACK))).toEqual(PACK);
  });

  it('saves to queries.yml (ensuring the dir) and loads it back', async () => {
    const { fs, mkdirs } = memFs();

    const path = await saveQueryPack(PACK, '/state', fs);
    expect(path).toBe(queriesPath('/state'));
    expect(mkdirs).toContain('/state');

    expect(await loadQueryPack('/state', fs)).toEqual(PACK);
  });

  it('returns null when no queries file exists', async () => {
    const { fs } = memFs();
    expect(await loadQueryPack('/state', fs)).toBeNull();
  });

  it('loads an explicit --queries file path', async () => {
    const { fs } = memFs({ '/custom/pack.yml': toYaml(PACK) });
    expect(await loadQueryPackFromFile('/custom/pack.yml', fs)).toEqual(PACK);
  });

  it('throws QueryPackError on a malformed pack (bad intent)', () => {
    const bad = toYaml(PACK).replace('best-of', 'not-an-intent');
    expect(() => parseQueryPack(bad)).toThrow(QueryPackError);
  });

  it('parseQueryPack throws SchemaVersionError on an incompatible schema_version (rule #2)', () => {
    // The pure parser (also used for an explicit --queries file) surfaces the
    // mismatch; only the cache loader below recovers from it.
    const bad = toYaml({ ...PACK, schema_version: '0.1' });
    expect(() => parseQueryPack(bad)).toThrow(SchemaVersionError);
  });

  it('loadQueryPack treats an incompatible cached pack as absent (regenerate, not abort)', async () => {
    const { fs } = memFs({
      [queriesPath('/state')]: toYaml({ ...PACK, schema_version: '0.1' }),
    });
    expect(await loadQueryPack('/state', fs)).toBeNull();
  });

  it('throws QueryPackError when queries is missing', () => {
    // Must carry the CURRENT version, or this trips SchemaVersionError first and
    // silently stops testing the missing-field path. Interpolated so a future
    // bump cannot rot it (a hardcoded literal here broke on the 0.1 -> 0.2 bump).
    expect(() =>
      parseQueryPack(`schema_version: "${SCHEMA_VERSION}"\ndomain: x`),
    ).toThrow(QueryPackError);
  });
});
