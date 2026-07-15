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
