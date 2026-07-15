#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Command } from 'commander';

/**
 * Read the package version at runtime.
 *
 * Resolved relative to this module so it works both when run from source via
 * `tsx src/cli/index.ts` (this file at `src/cli/`) and from the built output
 * at `dist/cli/index.js` - in both layouts `../../package.json` is the package
 * root. package.json is always present in a published npm package.
 */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

/** Build the commander program. Kept side-effect free so tests can inspect it. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('optifeed-visibility')
    .description(
      'Open-source AI visibility checker. Is your brand recommended by AI engines?',
    )
    .version(getVersion(), '-v, --version', 'print the version');
  return program;
}

/** True when this file is being executed directly (not imported by a test). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  buildProgram().parse(process.argv);
}
