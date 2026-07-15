import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import { VARIANCE_NOTE, type VisibilityEnvelope } from './envelope.js';
import {
  SnapshotParseError,
  type SnapshotFs,
  listSnapshots,
  loadSnapshot,
  saveSnapshot,
  snapshotFileName,
  snapshotsDir,
} from './snapshot.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: [],
  competitors: [],
};

function envelope(generatedAt: string): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt,
    domain: 'caferio.example',
    profile: PROFILE,
    score: 61,
    engines: [],
    shareOfVoice: [],
    sources: [],
    mentions: [],
    answers: [],
    findings: [],
    sampling: {
      nPrompts: 2,
      nAnswers: 6,
      judged: 0,
      varianceNote: VARIANCE_NOTE,
    },
  };
}

/** In-memory fs the tests inject, so nothing touches disk (hard rule #3). */
function fakeFs(): SnapshotFs & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async readdir(path) {
      if (!dirs.has(path)) {
        const err = new Error('no dir') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length));
    },
  };
}

describe('snapshotFileName', () => {
  it('sanitizes colons so the name is cross-platform (Windows-safe)', () => {
    expect(snapshotFileName('2026-07-15T00:00:00.000Z')).toBe(
      '2026-07-15T00-00-00.000Z.json',
    );
  });

  it('stays lexically sortable in chronological order', () => {
    const a = snapshotFileName('2026-07-15T00:00:00.000Z');
    const b = snapshotFileName('2026-07-16T00:00:00.000Z');
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('saveSnapshot / loadSnapshot round-trip', () => {
  it('writes under snapshots/ and reads back an equal envelope', async () => {
    const fs = fakeFs();
    const env = envelope('2026-07-15T00:00:00.000Z');

    const path = await saveSnapshot(env, '/state', fs);

    expect(path).toBe(
      `${snapshotsDir('/state')}/2026-07-15T00-00-00.000Z.json`,
    );
    const loaded = await loadSnapshot(path, fs);
    expect(loaded).toEqual(env);
  });

  it('persists no API keys (envelope carries none by contract)', async () => {
    const fs = fakeFs();
    await saveSnapshot(envelope('2026-07-15T00:00:00.000Z'), '/state', fs);
    for (const data of fs.files.values()) {
      expect(data.toLowerCase()).not.toContain('api_key');
      expect(data).not.toMatch(/sk-[A-Za-z0-9]/);
    }
  });
});

describe('loadSnapshot failure modes', () => {
  it('throws SnapshotParseError on non-JSON content', async () => {
    const fs = fakeFs();
    await fs.mkdir(snapshotsDir('/state'));
    const path = `${snapshotsDir('/state')}/broken.json`;
    await fs.writeFile(path, 'not json at all');
    await expect(loadSnapshot(path, fs)).rejects.toBeInstanceOf(
      SnapshotParseError,
    );
  });

  it('throws SnapshotParseError when schema_version is missing', async () => {
    const fs = fakeFs();
    await fs.mkdir(snapshotsDir('/state'));
    const path = `${snapshotsDir('/state')}/bad.json`;
    await fs.writeFile(path, JSON.stringify({ domain: 'x', score: 1 }));
    await expect(loadSnapshot(path, fs)).rejects.toBeInstanceOf(
      SnapshotParseError,
    );
  });

  it('throws on an incompatible schema_version, not just a missing one (rule #2)', async () => {
    const fs = fakeFs();
    await fs.mkdir(snapshotsDir('/state'));
    const path = `${snapshotsDir('/state')}/future.json`;
    const future = {
      ...envelope('2026-07-15T00:00:00.000Z'),
      schema_version: '0.2',
    };
    await fs.writeFile(path, JSON.stringify(future));
    await expect(loadSnapshot(path, fs)).rejects.toBeInstanceOf(
      SnapshotParseError,
    );
  });

  it('throws when a required object like sampling is missing', async () => {
    const fs = fakeFs();
    await fs.mkdir(snapshotsDir('/state'));
    const path = `${snapshotsDir('/state')}/nosampling.json`;
    const { sampling: _sampling, ...rest } = envelope(
      '2026-07-15T00:00:00.000Z',
    );
    await fs.writeFile(path, JSON.stringify(rest));
    await expect(loadSnapshot(path, fs)).rejects.toBeInstanceOf(
      SnapshotParseError,
    );
  });
});

describe('listSnapshots', () => {
  it('returns saved snapshot paths sorted chronologically', async () => {
    const fs = fakeFs();
    await saveSnapshot(envelope('2026-07-16T00:00:00.000Z'), '/state', fs);
    await saveSnapshot(envelope('2026-07-15T00:00:00.000Z'), '/state', fs);

    const paths = await listSnapshots('/state', fs);
    expect(paths).toEqual([
      `${snapshotsDir('/state')}/2026-07-15T00-00-00.000Z.json`,
      `${snapshotsDir('/state')}/2026-07-16T00-00-00.000Z.json`,
    ]);
  });

  it('returns an empty list when no snapshots directory exists yet', async () => {
    const fs = fakeFs();
    expect(await listSnapshots('/state', fs)).toEqual([]);
  });

  it('ignores non-snapshot files in the directory', async () => {
    const fs = fakeFs();
    await saveSnapshot(envelope('2026-07-15T00:00:00.000Z'), '/state', fs);
    await fs.writeFile(`${snapshotsDir('/state')}/README.txt`, 'notes');
    const paths = await listSnapshots('/state', fs);
    expect(paths).toHaveLength(1);
  });
});
