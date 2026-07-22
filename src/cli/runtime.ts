/**
 * The CLI runtime: every side effect a command needs (stdout/stderr, env, cwd,
 * clock, fs, fetcher) behind one injectable object, so command tests run with
 * no process globals and no network. Production wires it from `process`.
 *
 * This is adapter/wiring only - it constructs concrete collaborators and hands
 * them to `core/run`. No pipeline logic lives here (hard rule #1).
 */
import { accessSync, constants } from 'node:fs';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import process from 'node:process';
import { loadEnvFile } from '../core/index.js';
import { createFetcher, type Fetcher } from '../core/fetcher/index.js';
import { nodeQueryFs, type QueryFs } from '../core/queries/index.js';
import { nodeSnapshotFs, type SnapshotFs } from '../core/output/index.js';
import type { RunCheckDeps } from '../core/run/index.js';

/** Parsed `check` flags, normalized from commander options. */
export interface CheckFlags {
  yes?: boolean;
  json?: boolean;
  report?: string;
  quick?: boolean;
  engines?: string[];
  judge?: string;
  maxCost?: number;
  maxSetupCost?: number;
  /** Ask engines in grounded (web-search) mode where they support it. */
  grounded?: boolean;
  /** CI gate: exit non-zero when the score is under this (dev-plan M8). */
  failUnder?: number;
  refresh?: boolean;
  regenerate?: boolean;
  brand?: string;
  category?: string;
  queries?: string;
}

/** All the process-level effects the CLI commands need, injectable for tests. */
export interface Runtime {
  out(s: string): void;
  err(s: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  homeDir: string;
  isTTY: boolean;
  /** Whether `<cwd>/.optifeed` is writable (drives `resolveStateDir`). */
  isProjectWritable: boolean;
  now(): string;
  /** Write a report file (the HTML `--report` output). */
  writeFile(path: string, data: string): Promise<void>;
  /** Shared fetcher for audit + check. */
  fetcher: Fetcher;
  /** Snapshot fs for the read-only inspect commands (`diff`, `sources`). */
  snapshotFs: SnapshotFs;
  /** Query-pack fs for the `queries` command. */
  queryFs: QueryFs;
  /** Override the check pipeline's injected deps (tests bypass real adapters). */
  checkDeps?: (flags: CheckFlags) => RunCheckDeps;
  /**
   * Outcome of the `.env` auto-load, when a `.env` was present. Absent when
   * there was none - the ordinary case of keys exported in the shell.
   */
  envFile?: { path?: string; reason?: string };
}

function projectWritable(cwd: string): boolean {
  try {
    accessSync(cwd, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The production runtime, wired from `process`. */
export function defaultRuntime(): Runtime {
  // Load `<cwd>/.env` BEFORE reading process.env, so keys in a local .env are
  // visible to engine detection. Values already exported in the shell win.
  const dotenv = loadEnvFile({ cwd: process.cwd() });
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
    envFile:
      dotenv.loaded || dotenv.reason
        ? { path: dotenv.path, reason: dotenv.reason }
        : undefined,
    cwd: process.cwd(),
    homeDir: homedir(),
    isTTY: Boolean(process.stdout.isTTY),
    isProjectWritable: projectWritable(process.cwd()),
    now: () => new Date().toISOString(),
    writeFile: (path, data) => fsWriteFile(path, data, 'utf8'),
    fetcher: createFetcher(),
    snapshotFs: nodeSnapshotFs(),
    queryFs: nodeQueryFs(),
  };
}
