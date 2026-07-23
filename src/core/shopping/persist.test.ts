import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import { SchemaVersionError } from '../validation.js';
import { buildShoppingEnvelope, type ShoppingEnvelope } from './envelope.js';
import {
  ShoppingRunParseError,
  listShoppingRuns,
  loadShoppingRun,
  saveShoppingRun,
  shoppingDir,
  type ShoppingFs,
} from './persist.js';

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: ShoppingFs = {
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
    async readdir(path) {
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
  };
  return { fs, files };
}

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  competitors: [],
};

function envelope(generatedAt = '2026-07-23T09:00:00.000Z'): ShoppingEnvelope {
  return buildShoppingEnvelope({
    profile: PROFILE,
    products: [{ name: 'Aria 2' }],
    skus: [
      {
        product: 'Aria 2',
        merchantRank: 1,
        visibility: 40,
        engines: [],
        answers: 2,
        mentions: 1,
        avgPosition: 1,
        shelf: [],
        rows: [],
        reputationRows: [],
      },
    ],
    answers: [],
    rowsAnalyzed: 2,
    judged: 0,
    generatedAt,
  });
}

describe('saveShoppingRun', () => {
  it('writes into its own directory, apart from check snapshots', async () => {
    const { fs, files } = memFs();
    const path = await saveShoppingRun(envelope(), '/state', fs);

    expect(path.startsWith(shoppingDir('/state'))).toBe(true);
    expect(path).not.toContain('snapshots');
    expect(path.endsWith('.json')).toBe(true);
    // Windows-safe filename: no colons from the ISO timestamp.
    expect(path.split('/').pop()).not.toContain(':');
    expect(files.size).toBe(1);
  });

  it('round trips through load', async () => {
    const { fs } = memFs();
    const path = await saveShoppingRun(envelope(), '/state', fs);
    const loaded = await loadShoppingRun(path, fs);
    expect(loaded.rankingDelta[0]?.product).toBe('Aria 2');
    expect(loaded.schema_version).toBe(SCHEMA_VERSION);
  });

  it('lists saved runs oldest first', async () => {
    const { fs } = memFs();
    await saveShoppingRun(envelope('2026-07-23T09:00:00.000Z'), '/state', fs);
    await saveShoppingRun(envelope('2026-07-24T09:00:00.000Z'), '/state', fs);
    const paths = await listShoppingRuns('/state', fs);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('2026-07-23');
    expect(paths[1]).toContain('2026-07-24');
  });

  it('returns no runs when nothing has been saved yet', async () => {
    const { fs } = memFs();
    expect(await listShoppingRuns('/state', fs)).toEqual([]);
  });
});

describe('loadShoppingRun', () => {
  // Same contract as loadSnapshot: a version mismatch surfaces as the distinct,
  // catchable SchemaVersionError so a caller can tell "incompatible" from
  // "corrupt". A saved run is history, not a rebuildable cache, so it is never
  // silently treated as absent.
  it('rejects an unsupported schema_version', async () => {
    const raw = JSON.stringify({ ...envelope(), schema_version: '0.1' });
    const { fs } = memFs({ '/state/shopping/a.json': raw });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      SchemaVersionError,
    );
  });

  it('rejects a hand edit that removed a field consumers read', async () => {
    const broken = { ...envelope() } as Record<string, unknown>;
    delete broken.rankingDelta;
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      /rankingDelta/,
    );
  });

  it('rejects a partially hand-edited spend block', async () => {
    const broken = { ...envelope(), spend: { setupUsd: 0.1 } };
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      ShoppingRunParseError,
    );
  });

  it('rejects a file that is not JSON at all', async () => {
    const { fs } = memFs({ '/state/shopping/a.json': 'not json' });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      ShoppingRunParseError,
    );
  });
});
