/**
 * Snapshot persistence for the M8 envelope: save each `check` run's full JSON
 * to `<stateDir>/snapshots/<ISO>.json` so runs can be diffed over time
 * ({@link diffEnvelopes}).
 *
 * All fs access is injected so unit tests run with an in-memory fake and no
 * disk (hard rule #3). The envelope carries no secrets (hard rule #4), so a
 * snapshot never persists an API key. The on-disk filename sanitizes the ISO
 * timestamp's colons to stay valid on Windows while remaining lexically
 * sortable in chronological order.
 */
import { join } from 'node:path';
import { createValidator } from '../validation.js';
import type { VisibilityEnvelope } from './envelope.js';

/** The minimal fs surface snapshot persistence needs, injectable for tests. */
export interface SnapshotFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** Thrown when a snapshot file is present but not a valid envelope. */
export class SnapshotParseError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(`Snapshot at ${path} is not a valid envelope`);
    this.name = 'SnapshotParseError';
  }
}

const SNAPSHOT_EXT = '.json';

/** The snapshots directory inside a state directory. */
export function snapshotsDir(stateDir: string): string {
  return join(stateDir, 'snapshots');
}

/**
 * Filename for a snapshot taken at `generatedAt`. Colons are replaced with `-`
 * (invalid in Windows filenames); the rest of the ISO string is left intact so
 * names still sort chronologically as plain strings.
 */
export function snapshotFileName(generatedAt: string): string {
  return `${generatedAt.replace(/:/g, '-')}${SNAPSHOT_EXT}`;
}

/** Node fs.promises adapter for production use. */
export function nodeSnapshotFs(): SnapshotFs {
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
    async readdir(path) {
      const { readdir } = await import('node:fs/promises');
      return readdir(path);
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Persist an envelope as pretty JSON, ensuring the snapshots dir exists.
 *
 * Files are keyed by `generatedAt` (the plan's `<ISO>.json`), so a re-save at
 * the identical millisecond overwrites - idempotent by design. A real `check`
 * run spends seconds querying engines, so two runs never share a millisecond
 * timestamp; the collision only arises under a deliberately fixed clock.
 */
export async function saveSnapshot(
  envelope: VisibilityEnvelope,
  stateDir: string,
  fs: SnapshotFs,
): Promise<string> {
  const dir = snapshotsDir(stateDir);
  await fs.mkdir(dir);
  const path = join(dir, snapshotFileName(envelope.generatedAt));
  await fs.writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`);
  return path;
}

/**
 * Load a persisted snapshot. A present-but-corrupt file throws
 * {@link SnapshotParseError} rather than being treated as empty.
 */
export async function loadSnapshot(
  path: string,
  fs: SnapshotFs,
): Promise<VisibilityEnvelope> {
  const raw = await fs.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotParseError(path, err);
  }
  return validateEnvelope(parsed, path);
}

/** Validate a parsed snapshot's required envelope shape (a hand edit can break it). */
function validateEnvelope(raw: unknown, path: string): VisibilityEnvelope {
  const v = createValidator((why) => {
    throw new SnapshotParseError(path, new Error(why));
  });
  const obj = v.object(raw, 'snapshot');
  // Reject an incompatible schema outright rather than diff mismatched shapes
  // (hard rule #2: a breaking change bumps the version).
  v.schemaVersion(obj);
  v.string(obj, 'domain');
  v.string(obj, 'generatedAt');
  v.number(obj, 'score');
  v.objectField(obj, 'profile');
  v.array(obj, 'engines');
  v.array(obj, 'shareOfVoice');
  v.array(obj, 'sources');
  v.array(obj, 'mentions');
  v.array(obj, 'answers');
  v.array(obj, 'findings');
  v.objectField(obj, 'sampling');
  return obj as unknown as VisibilityEnvelope;
}

/**
 * List saved snapshot paths, sorted chronologically (oldest first). Returns an
 * empty list when no snapshots directory exists yet.
 */
export async function listSnapshots(
  stateDir: string,
  fs: SnapshotFs,
): Promise<string[]> {
  const dir = snapshotsDir(stateDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(SNAPSHOT_EXT))
    .sort()
    .map((n) => join(dir, n));
}
