/**
 * Read/write `profile.json` (M4). All fs access is injected so unit tests run
 * with an in-memory fake and no disk (hard rule #3). Never persists secrets -
 * a BrandProfile carries no keys (hard rule #4).
 */
import { join } from 'node:path';
import type { BrandProfile } from '../types.js';
import { createValidator, SchemaVersionError } from '../validation.js';

/** The minimal fs surface discovery needs, injectable for tests. */
export interface ProfileFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Thrown when an existing profile file is present but not valid JSON. */
export class ProfileParseError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(`profile.json at ${path} is not valid JSON`);
    this.name = 'ProfileParseError';
  }
}

/** The canonical profile path inside a state directory. */
export function profilePath(stateDir: string): string {
  return join(stateDir, 'profile.json');
}

/** Node fs.promises adapter for production use. */
export function nodeProfileFs(): ProfileFs {
  return {
    async readFile(path) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
    async writeFile(path, data) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, data, 'utf8');
    },
    async mkdir(path) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path, { recursive: true });
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Load a persisted profile, or `null` if none exists yet. A present-but-corrupt
 * file throws {@link ProfileParseError} rather than silently clobbering it.
 */
export async function loadProfile(
  stateDir: string,
  fs: ProfileFs,
): Promise<BrandProfile | null> {
  const path = profilePath(stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProfileParseError(path, err);
  }
  try {
    return validateProfile(parsed, path);
  } catch (err) {
    // A stale-version cache is rebuildable: treat it as absent so the caller
    // re-discovers (and overwrites with the current schema) instead of aborting
    // the run. Genuine corruption still surfaces as ProfileParseError.
    if (err instanceof SchemaVersionError) return null;
    throw err;
  }
}

/** Validate a parsed profile's required shape (a hand edit can break it). */
function validateProfile(raw: unknown, path: string): BrandProfile {
  const v = createValidator((why) => {
    throw new ProfileParseError(path, new Error(why));
  });
  const obj = v.object(raw, 'profile');
  v.schemaVersion(obj);
  v.string(obj, 'domain');
  v.string(obj, 'brand');
  v.array(obj, 'aliases');
  v.array(obj, 'competitors');
  // Optional, but M5's `activeIntents` dereferences it to choose the prompt
  // axis, so a hand-edited typo must fail at load rather than silently
  // selecting the wrong axis (M8 review lesson #3: a validator vouches for
  // every field a consumer reads).
  const businessType = (obj as Record<string, unknown>).businessType;
  if (
    businessType !== undefined &&
    businessType !== 'retailer' &&
    businessType !== 'maker' &&
    businessType !== 'service'
  ) {
    throw new ProfileParseError(
      path,
      new Error('businessType must be retailer, maker or service'),
    );
  }
  return obj as unknown as BrandProfile;
}

/** Persist a profile as pretty JSON, ensuring the state directory exists. */
export async function saveProfile(
  profile: BrandProfile,
  stateDir: string,
  fs: ProfileFs,
): Promise<string> {
  await fs.mkdir(stateDir);
  const path = profilePath(stateDir);
  await fs.writeFile(path, `${JSON.stringify(profile, null, 2)}\n`);
  return path;
}
