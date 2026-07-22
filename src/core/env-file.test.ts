import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from './env-file.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'optifeed-env-'));
  tmpDirs.push(dir);
  return dir;
}

const touchedKeys: string[] = [];
function trackKey(key: string): void {
  touchedKeys.push(key);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  for (const key of touchedKeys.splice(0)) delete process.env[key];
});

describe('loadEnvFile', () => {
  it('loads keys from a .env in the working directory', () => {
    const dir = tempDir();
    trackKey('OPTIFEED_TEST_ONE');
    writeFileSync(join(dir, '.env'), 'OPTIFEED_TEST_ONE=from_file\n');

    const result = loadEnvFile({ cwd: dir });

    expect(result.loaded).toBe(true);
    expect(result.path).toBe(join(dir, '.env'));
    expect(process.env.OPTIFEED_TEST_ONE).toBe('from_file');
  });

  it('never overrides a value already set in the environment', () => {
    // The shell is the more explicit source: a key exported for one run must
    // win over a stale .env sitting in the directory.
    const dir = tempDir();
    trackKey('OPTIFEED_TEST_TWO');
    process.env.OPTIFEED_TEST_TWO = 'from_shell';
    writeFileSync(join(dir, '.env'), 'OPTIFEED_TEST_TWO=from_file\n');

    loadEnvFile({ cwd: dir });

    expect(process.env.OPTIFEED_TEST_TWO).toBe('from_shell');
  });

  it('is a silent no-op when there is no .env (the common case)', () => {
    const result = loadEnvFile({ cwd: tempDir() });
    expect(result).toEqual({ loaded: false });
  });

  it('never throws on an unreadable .env - it reports and carries on', () => {
    // A directory named .env fails to read on every platform (the Windows CI
    // leg cannot express an unreadable file via chmod).
    const dir = tempDir();
    mkdirSync(join(dir, '.env'));

    const result = loadEnvFile({ cwd: dir });

    expect(result.loaded).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('reports honestly when the Node runtime is too old to load .env files', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'OPTIFEED_TEST_FOUR=x\n');

    // null models a runtime without process.loadEnvFile (before Node 20.12).
    const result = loadEnvFile({ cwd: dir, load: null });

    expect(result.loaded).toBe(false);
    expect(result.reason).toContain('Node');
  });
});
