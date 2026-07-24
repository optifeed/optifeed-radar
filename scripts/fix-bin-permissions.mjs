#!/usr/bin/env node
/**
 * Build step: make every `bin` target in package.json executable.
 *
 * `tsc` writes its output at 0644, so a freshly built `dist/cli/index.js` is
 * not runnable on its own. npm hides that most of the time: bin-links chmods
 * a bin target whenever it creates the symlink, so a registry install, a
 * `file:` dependency, `npm link` and `npx <path>` all produce a working
 * binary - at link time. Nothing maintains the bit afterwards, and the next
 * `npm run build` deletes and recreates the file at 0644 behind the same
 * symlink:
 *
 *     sh: .../node_modules/.bin/optifeed-radar: Permission denied
 *
 * That rebuild-after-link loop is how this surfaced. Executing
 * `dist/cli/index.js` directly, with no npm step in between, fails the same
 * way. Leaving the bit to the installer also means the published tarball
 * carries 0644 and depends on every consumer being as generous as npm is.
 * The build owns executability; this restores it after `tsc`.
 *
 * On Windows the call is effectively a no-op (there are no POSIX permission
 * bits, and npm generates `.cmd` shims instead) - it is safe to run there, so
 * the build stays one command on every platform.
 *
 * Usage: node scripts/fix-bin-permissions.mjs [packageRoot]
 */
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.argv[2] ?? '.');
const manifest = resolve(root, 'package.json');

/** @type {{ bin?: Record<string, string> | string }} */
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));

// `bin` may be a bare string (shorthand for a single bin named after the
// package) or a map; normalise before walking it.
const targets =
  typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});

if (targets.length === 0) {
  console.error(
    `${manifest} declares no bin, so there is nothing to make executable. ` +
      'If the package no longer ships a CLI, drop this step from the build.',
  );
  process.exit(1);
}

for (const target of targets) {
  const file = resolve(root, target);
  try {
    statSync(file);
  } catch {
    console.error(
      `bin target ${target} does not exist. Run the build before this step ` +
        '(or fix the "bin" entry in package.json).',
    );
    process.exit(1);
  }
  chmodSync(file, 0o755);
}

console.log(
  `Made ${targets.length} bin target(s) executable: ${targets.join(', ')}`,
);
