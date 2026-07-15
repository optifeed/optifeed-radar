import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram, getVersion } from '../src/cli/index.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('cli', () => {
  it('getVersion() matches package.json', () => {
    expect(getVersion()).toBe(pkg.version);
  });

  it('builds a named, versioned program', () => {
    const program = buildProgram();
    expect(program.name()).toBe('optifeed-visibility');
    expect(program.version()).toBe(pkg.version);
  });

  it('--version prints the version', () => {
    const program = buildProgram().exitOverride();
    let out = '';
    program.configureOutput({ writeOut: (s) => (out += s) });

    // With exitOverride, commander throws instead of calling process.exit.
    expect(() => program.parse(['node', 'cli', '--version'])).toThrow();
    expect(out.trim()).toBe(pkg.version);
  });
});
