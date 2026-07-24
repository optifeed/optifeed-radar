/**
 * The built bin must be RUNNABLE, not merely present.
 *
 * `tsc` writes its output at 0644. Nothing in the build restored the execute
 * bit, so `dist/cli/index.js` came out non-executable and any consumer that
 * runs the file on its own mode got EACCES:
 *
 *     sh: .../node_modules/.bin/optifeed-radar: Permission denied
 *
 * npm hides this at install time - bin-links chmods a bin target whenever it
 * creates the symlink, for registry installs, `file:` deps, `npm link` and
 * `npx <path>` alike. Nothing maintains the bit afterwards, so the next build
 * leaves a fresh 0644 file behind a symlink npm already linked. The tarball
 * shipped 0644 too, so executability depended entirely on the installer being
 * generous. It shouldn't: the build owns this.
 *
 * These tests drive `scripts/fix-bin-permissions.mjs` (the build step that
 * fixes it) through a real subprocess against throwaway package roots.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const script = fileURLToPath(new URL('scripts/fix-bin-permissions.mjs', root));

const pkg = JSON.parse(read('package.json')) as {
  bin: Record<string, string>;
  scripts: Record<string, string>;
};

/**
 * Windows has no POSIX permission bits - `chmodSync` there only toggles the
 * read-only flag, and executability comes from npm's generated `.cmd` shims,
 * not from the file's mode. Asserting on mode bits would fail on the Windows
 * leg of the CI matrix for a reason that says nothing about this bug, so the
 * mode assertions run where modes are real and the failure modes run everywhere.
 */
const modesAreReal = process.platform !== 'win32';

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway package root whose files all start out non-executable (0644). */
function fakePackage(manifest: object, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'optifeed-bin-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/usr/bin/env node\n');
    chmodSync(path, 0o644); // explicit: writeFileSync's mode is umask-dependent
  }
  return dir;
}

const fix = (dir: string) =>
  spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });

const isExecutable = (dir: string, rel: string) =>
  (statSync(join(dir, rel)).mode & 0o111) === 0o111;

describe('fix-bin-permissions', () => {
  it.skipIf(!modesAreReal)('makes every declared bin target executable', () => {
    const dir = fakePackage(
      {
        name: 'x',
        bin: { cli: 'dist/cli/index.js', mcp: 'dist/mcp/index.js' },
      },
      ['dist/cli/index.js', 'dist/mcp/index.js'],
    );

    expect(isExecutable(dir, 'dist/cli/index.js')).toBe(false);

    const run = fix(dir);

    expect(run.status, run.stderr).toBe(0);
    expect(isExecutable(dir, 'dist/cli/index.js')).toBe(true);
    expect(isExecutable(dir, 'dist/mcp/index.js')).toBe(true);
  });

  it.skipIf(!modesAreReal)('leaves the rest of the build output alone', () => {
    // Only entrypoints are executed directly; marking library output +x would
    // widen the blast radius of a build step that exists to fix two files.
    const dir = fakePackage({ name: 'x', bin: { cli: 'dist/cli/index.js' } }, [
      'dist/cli/index.js',
      'dist/core/run/index.js',
    ]);

    expect(fix(dir).status).toBe(0);
    expect(isExecutable(dir, 'dist/core/run/index.js')).toBe(false);
  });

  it('fails loudly when a declared bin target is missing', () => {
    // Silently skipping a missing target is how a half-built dist ships: the
    // build stays green and the bin is discovered broken by a user instead.
    const dir = fakePackage(
      { name: 'x', bin: { cli: 'dist/cli/index.js' } },
      [],
    );

    const run = fix(dir);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('dist/cli/index.js');
  });

  it('fails loudly when the manifest declares no bin at all', () => {
    const dir = fakePackage({ name: 'x' }, []);

    const run = fix(dir);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/declares no bin/i);
  });
});

describe('the build ships runnable entrypoints', () => {
  it('fixes bin permissions after compiling', () => {
    // Order matters: `tsc` recreates the files, so a chmod that ran before it
    // would be undone by the very step it is meant to correct.
    const build = pkg.scripts.build ?? '';
    expect(build).toContain('fix-bin-permissions');
    expect(build.indexOf('tsc')).toBeLessThan(
      build.indexOf('fix-bin-permissions'),
    );
  });

  it('keeps a node shebang on every bin source', () => {
    // The execute bit is only half the contract: without a shebang the shell
    // execs the file as a shell script and it fails just as hard.
    for (const target of Object.values(pkg.bin)) {
      const src = target.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(read(src).startsWith('#!/usr/bin/env node\n'), src).toBe(true);
    }
  });
});
