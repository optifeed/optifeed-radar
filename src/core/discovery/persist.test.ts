import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import {
  ProfileParseError,
  loadProfile,
  profilePath,
  saveProfile,
  type ProfileFs,
} from './persist.js';

/** An in-memory ProfileFs mirroring node's ENOENT behavior. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const mkdirs: string[] = [];
  const fs: ProfileFs = {
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

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme',
  aliases: [],
  competitors: ['Estes'],
  generatedAt: '2026-07-15T00:00:00.000Z',
  sources: { brand: 'extracted', competitors: 'llm' },
};

describe('profile persistence', () => {
  it('round-trips a profile through save/load', async () => {
    const { fs, mkdirs } = memFs();

    const path = await saveProfile(PROFILE, '/state', fs);
    expect(path).toBe(profilePath('/state'));
    expect(mkdirs).toContain('/state'); // ensured the directory

    const loaded = await loadProfile('/state', fs);
    expect(loaded).toEqual(PROFILE);
  });

  it('returns null when no profile file exists yet', async () => {
    const { fs } = memFs();
    expect(await loadProfile('/state', fs)).toBeNull();
  });

  it('throws ProfileParseError on a corrupt profile file (never clobbers)', async () => {
    const { fs } = memFs({ [profilePath('/state')]: '{ not json' });
    await expect(loadProfile('/state', fs)).rejects.toBeInstanceOf(
      ProfileParseError,
    );
  });

  it('treats a cached profile with an incompatible schema_version as absent (re-discover, not abort)', async () => {
    // rule #2: never USE an incompatible cache - but a stale-version profile is
    // rebuildable, so the loader returns null (the caller re-discovers) rather
    // than throwing and aborting a whole run after a future schema bump.
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify({
        ...PROFILE,
        schema_version: '0.1',
      }),
    });
    expect(await loadProfile('/state', fs)).toBeNull();
  });

  it('throws ProfileParseError on a structurally invalid profile', async () => {
    // Valid JSON but missing required fields / wrong types.
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify({
        domain: 'x.com',
        brand: 'X',
        competitors: 'not-an-array',
      }),
    });
    await expect(loadProfile('/state', fs)).rejects.toBeInstanceOf(
      ProfileParseError,
    );
  });
});

describe('businessType validation (M5a)', () => {
  // M5 dereferences this to pick the prompt axis, so a hand-edited typo must
  // fail loudly at load rather than silently selecting the wrong axis.
  it('rejects a hand-edited businessType that is not a known value', async () => {
    const bad = JSON.stringify({
      schema_version: SCHEMA_VERSION,
      domain: 'shop.example',
      brand: 'Shop',
      aliases: [],
      competitors: [],
      businessType: 'wholesaler',
    });
    const { fs } = memFs({ [profilePath('/state')]: bad });

    await expect(loadProfile('/state', fs)).rejects.toThrow(ProfileParseError);
  });

  it('accepts a profile with no businessType at all (pre-M5a files)', async () => {
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify({
        schema_version: SCHEMA_VERSION,
        domain: 'shop.example',
        brand: 'Shop',
        aliases: [],
        competitors: [],
      }),
    });

    const loaded = await loadProfile('/state', fs);

    expect(loaded?.businessType).toBeUndefined();
  });
});
