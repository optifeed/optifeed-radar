/**
 * Shopping-run persistence (M12a): `<stateDir>/shopping/<ISO>.json`.
 *
 * A SEPARATE directory from the check snapshots on purpose. `diff` compares the
 * two most recent files in `snapshots/`, and a shopping run dropped in there
 * would eventually be diffed against a brand check - two artifacts that are not
 * the same measurement (the M8 lesson about verifying that two persisted files
 * are actually comparable).
 *
 * All fs access is injected so unit tests run with no disk (hard rule #3). The
 * envelope carries no secrets (hard rule #4).
 */
import { join } from 'node:path';
import { createValidator } from '../validation.js';
import type { ShoppingEnvelope } from './envelope.js';

/**
 * The minimal fs surface this module needs, injectable for tests. Structurally
 * identical to `SnapshotFs` in `core/output` - declared here rather than
 * imported so `core/shopping` and `core/output` stay one-directional (output
 * renders shopping, shopping never reaches back into output).
 */
export interface ShoppingFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** Thrown when a saved shopping run is present but not a valid envelope. */
export class ShoppingRunParseError extends Error {
  constructor(
    public readonly path: string,
    public override readonly cause: unknown,
  ) {
    super(
      `Shopping run at ${path} is not a valid envelope: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'ShoppingRunParseError';
  }
}

const RUN_EXT = '.json';

/** The shopping-runs directory inside a state directory. */
export function shoppingDir(stateDir: string): string {
  return join(stateDir, 'shopping');
}

/**
 * Filename for a run taken at `generatedAt`. Colons are replaced with `-`
 * (invalid on Windows); the rest of the ISO string stays intact so names sort
 * chronologically as plain strings.
 */
export function shoppingFileName(generatedAt: string): string {
  return `${generatedAt.replace(/:/g, '-')}${RUN_EXT}`;
}

/** Node fs.promises adapter for production use. */
export function nodeShoppingFs(): ShoppingFs {
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

/** Persist a shopping envelope as pretty JSON, creating the directory. */
export async function saveShoppingRun(
  envelope: ShoppingEnvelope,
  stateDir: string,
  fs: ShoppingFs,
): Promise<string> {
  const dir = shoppingDir(stateDir);
  await fs.mkdir(dir);
  const path = join(dir, shoppingFileName(envelope.generatedAt));
  await fs.writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`);
  return path;
}

/** Load a saved shopping run; a corrupt file throws rather than reading empty. */
export async function loadShoppingRun(
  path: string,
  fs: ShoppingFs,
): Promise<ShoppingEnvelope> {
  const raw = await fs.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ShoppingRunParseError(path, err);
  }
  return validate(parsed, path);
}

/**
 * Validate a parsed run. Vouches for every field a consumer dereferences, not
 * a sample of them: a loader that validates half the shape gives false
 * confidence and the crash surfaces three layers away (M8 lesson #3).
 */
function validate(raw: unknown, path: string): ShoppingEnvelope {
  const v = createValidator((why) => {
    throw new ShoppingRunParseError(path, new Error(why));
  });
  const obj = v.object(raw, 'shopping run');
  // Compares the VALUE, not just the type: an incompatible file is refused
  // rather than half-read (hard rule #2).
  v.schemaVersion(obj);
  v.string(obj, 'domain');
  v.string(obj, 'generatedAt');
  v.objectField(obj, 'profile');
  v.array(obj, 'products');
  v.array(obj, 'skus');
  v.array(obj, 'answers');
  v.array(obj, 'notes');

  // Nested fields the renderers dereference directly. Validating only the
  // top-level containers would let a hand-edited file load "cleanly" and then
  // crash inside a report - the loader must vouch for every field a consumer
  // reads, not for the shape it happens to be wrapped in.
  const sampling = v.object(obj.sampling, 'sampling');
  for (const key of ['nProducts', 'nPrompts', 'nAnswers', 'nRows', 'judged']) {
    v.number(sampling, key);
  }
  v.number(sampling, 'judgeRateCap');
  v.string(sampling, 'varianceNote');

  (obj.skus as unknown[]).forEach((raw, i) => {
    const sku = v.object(raw, `sku ${i}`);
    v.string(sku, 'product');
    v.number(sku, 'categoryPrompts');
    v.number(sku, 'answers');
    v.number(sku, 'mentions');
    v.numberOrNull(sku, 'visibility');
    // Nullable and read by the summary row: unvalidated, `undefined` slips past
    // its `=== null` guard and renders "average shelf rank undefined".
    v.numberOrNull(sku, 'avgPosition');
    v.array(sku, 'engines');
    v.array(sku, 'shelf');
  });

  // Honesty flags: present-but-wrong-typed is worse than absent, since
  // `isPartialRun` reads them to decide whether the run was complete.
  for (const flag of ['costCapped', 'degraded']) {
    if (
      flag in obj &&
      obj[flag] !== undefined &&
      typeof obj[flag] !== 'boolean'
    ) {
      throw new ShoppingRunParseError(
        path,
        new Error(`${flag} must be a boolean`),
      );
    }
  }
  for (const list of ['skippedEngines', 'partialEngines']) {
    if (list in obj && obj[list] !== undefined) v.array(obj, list);
  }

  if ('spend' in obj && obj.spend !== undefined) {
    const spend = v.object(obj.spend, 'spend');
    v.number(spend, 'setupUsd');
    v.number(spend, 'mainUsd');
    v.number(spend, 'totalUsd');
  }
  return obj as unknown as ShoppingEnvelope;
}

/** List saved run paths, oldest first. Empty when nothing has been saved. */
export async function listShoppingRuns(
  stateDir: string,
  fs: ShoppingFs,
): Promise<string[]> {
  const dir = shoppingDir(stateDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(RUN_EXT))
    .sort()
    .map((n) => join(dir, n));
}
