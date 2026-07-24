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

/**
 * Seeds below are keyed with "/" paths, but the module builds paths with
 * node:path, which yields "\\" on Windows - so BOTH keys and lookups need
 * normalizing, exactly as the CLI suite already does. The CI matrix has caught
 * this shape of bug twice before.
 */
function normKey(p: string): string {
  return p.split('\\').join('/');
}

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [normKey(k), v]));
  const fs: ShoppingFs = {
    async readFile(path) {
      const data = files.get(normKey(path));
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
    async writeFile(path, data) {
      files.set(normKey(path), data);
    },
    async mkdir() {},
    async readdir(path) {
      const prefix = `${normKey(path)}/`;
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
        visibility: 40,
        engines: [],
        categoryPrompts: 3,
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
    expect(normKey(path).split('/').pop()).not.toContain(':');
    expect(files.size).toBe(1);
  });

  it('round trips through load', async () => {
    const { fs } = memFs();
    const path = await saveShoppingRun(envelope(), '/state', fs);
    const loaded = await loadShoppingRun(path, fs);
    expect(loaded.skus[0]?.product).toBe('Aria 2');
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
    delete broken.skus;
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      /skus/,
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

  // A loader that vouches only for the top-level containers gives false
  // confidence: the first nested field a renderer dereferences crashes three
  // layers away instead of failing here (CLAUDE.md, M8 lesson #3).
  it('rejects a hand edit inside sampling', async () => {
    const broken = envelope() as unknown as Record<string, unknown>;
    broken.sampling = { nProducts: 1, judged: 0 }; // varianceNote et al removed
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      ShoppingRunParseError,
    );
  });

  it('rejects a sku missing a field the report reads', async () => {
    const broken = JSON.parse(JSON.stringify(envelope())) as {
      skus: Record<string, unknown>[];
    };
    delete broken.skus[0]!.categoryPrompts;
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      /categoryPrompts/,
    );
  });

  it('rejects a sku missing the mention count the summary reads', async () => {
    const broken = JSON.parse(JSON.stringify(envelope())) as {
      skus: Record<string, unknown>[];
    };
    delete broken.skus[0]!.mentions;
    const { fs } = memFs({
      '/state/shopping/a.json': JSON.stringify(broken),
    });
    await expect(loadShoppingRun('/state/shopping/a.json', fs)).rejects.toThrow(
      ShoppingRunParseError,
    );
  });

  it('rejects an honesty flag of the wrong type', async () => {
    const broken = { ...envelope(), costCapped: 'yes' };
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
