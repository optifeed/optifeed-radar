/**
 * Auto-load a local `.env` so BYO keys just work.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node >= 20.12) rather than a
 * dependency. Its precedence is the one we want and is NOT re-implemented
 * here: a variable already present in the environment is left alone, so a key
 * exported for a single run always beats a stale `.env` in the directory.
 *
 * Never throws: a missing, unreadable or malformed `.env` degrades to a
 * reported reason and the run continues on whatever the environment already
 * has (the graceful-failure contract, lesson #5). Values are never read,
 * logged or echoed here - only whether loading happened.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export interface LoadEnvFileOptions {
  /** Directory to look in. Defaults to the current working directory. */
  cwd?: string;
  /**
   * The loader itself. Injected by tests; `null` models a runtime older than
   * Node 20.12, where `process.loadEnvFile` does not exist.
   */
  load?: ((path: string) => void) | null;
}

export interface LoadEnvFileResult {
  /** True only when a `.env` was found AND applied to `process.env`. */
  loaded: boolean;
  /** Absolute path of the file that was loaded. */
  path?: string;
  /** Why nothing was loaded, when a `.env` existed but could not be used. */
  reason?: string;
}

function defaultLoad(): ((path: string) => void) | null {
  return typeof process.loadEnvFile === 'function'
    ? (path: string) => process.loadEnvFile(path)
    : null;
}

/** Load `<cwd>/.env` into `process.env` if it exists. */
export function loadEnvFile(opts: LoadEnvFileOptions = {}): LoadEnvFileResult {
  const path = join(opts.cwd ?? process.cwd(), '.env');
  if (!existsSync(path)) return { loaded: false };

  const load = opts.load === undefined ? defaultLoad() : opts.load;
  if (!load) {
    return {
      loaded: false,
      reason:
        'found a .env but this Node cannot load it (needs Node 20.12 or newer); export the keys in your shell instead',
    };
  }

  try {
    load(path);
    return { loaded: true, path };
  } catch {
    // The thrown error can quote the offending line, which may be a key, so
    // it is deliberately not included in the reason (hard rule #4).
    return { loaded: false, reason: 'found a .env but could not read it' };
  }
}
