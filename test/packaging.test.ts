/**
 * M17 release engineering: what `npm publish` will actually ship.
 *
 * These are guards against the failure modes that only show up AFTER a
 * publish - a stale `dist/`, a bin that points at nothing, a README linking to
 * a file the tarball omits, or automation publishing without anyone deciding
 * to. All pure file reads, no network, no subprocess.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
const exists = (rel: string) => existsSync(new URL(rel, root));

interface PackageJson {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
}

const pkg = JSON.parse(read('package.json')) as PackageJson;

describe('package manifest', () => {
  it('carries a publishable semver version (0.0.0 is the scaffold placeholder)', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(pkg.version).not.toBe('0.0.0');
  });

  it('every bin target is built from a source entrypoint that exists', () => {
    for (const target of Object.values(pkg.bin)) {
      expect(target.startsWith('dist/')).toBe(true);
      const src = target.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(exists(src), `${target} has no source at ${src}`).toBe(true);
    }
  });

  it('ships no source, tests or scripts in the tarball', () => {
    for (const entry of pkg.files) {
      expect(['src', 'test', 'scripts', 'docs']).not.toContain(
        entry.replace(/\/$/, ''),
      );
    }
  });

  it('ships every repo file the README links to', () => {
    const linked = [...read('README.md').matchAll(/\]\(\.?\/?([A-Z]+\.md)\)/g)]
      .map((m) => m[1]!)
      .concat(
        // Bare filename references ("See METHODOLOGY.md") are links to a
        // published file too, as far as an npm reader is concerned.
        [...read('README.md').matchAll(/\b([A-Z]+\.md)\b/g)].map((m) => m[1]!),
      );
    for (const file of new Set(linked)) {
      expect(
        pkg.files,
        `README references ${file} but files omits it`,
      ).toContain(file);
    }
  });
});

describe('build', () => {
  it('removes stale output before compiling', () => {
    // `tsc` never deletes; `files: ["dist"]` publishes whatever is there, so a
    // module deleted from src/ would keep shipping until someone cleaned by
    // hand (this bit us at the 2026-07-17 M14 removal).
    expect(pkg.scripts.clean).toBeTruthy();
    expect(pkg.scripts.build).toContain('clean');
  });

  it('cleans cross-platform (the CI matrix includes Windows)', () => {
    expect(pkg.scripts.clean).not.toContain('rm -rf');
  });
});

/**
 * Publishing is MANUAL (the auto-publish workflow was removed 2026-07-24).
 *
 * These assert the inverse of what they used to: nothing in the repo can push
 * a release on its own. The point is not that automation is wrong - it is that
 * re-adding it has to be a conscious act that trips a test, rather than a
 * workflow file quietly appearing and publishing on the next tag.
 */
describe('publishing stays manual', () => {
  // No workflows directory at all is the MOST manual state there is, so it must
  // read as zero workflows. Letting `readdirSync` throw here fails collection
  // for the whole file, which silently takes every other packaging guard in it
  // down with it - a red that says nothing about what actually broke.
  const workflows = exists('.github/workflows/')
    ? readdirSync(new URL('.github/workflows/', root))
    : [];

  it('ships no release workflow', () => {
    expect(exists('.github/workflows/release.yml')).toBe(false);
  });

  it('has no workflow that publishes to npm', () => {
    for (const file of workflows) {
      const yml = read(`.github/workflows/${file}`);
      expect(yml, `${file} publishes to npm`).not.toMatch(/npm\s+publish/);
    }
  });

  it('has no package script that publishes', () => {
    // A `release` script running `npm publish` is the same hazard wearing a
    // different hat: one `npm run` away from an unintended publish.
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, `the "${name}" script publishes`).not.toMatch(
        /npm\s+publish/,
      );
    }
  });
});

describe('CI matrix', () => {
  it('covers Linux, macOS and Windows', () => {
    const yml = read('.github/workflows/ci.yml');
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      expect(yml).toContain(os);
    }
  });
});

describe('release docs', () => {
  it('ships a security policy and a changelog', () => {
    expect(exists('SECURITY.md')).toBe(true);
    expect(exists('CHANGELOG.md')).toBe(true);
  });
});

describe('npm metadata for publishing', () => {
  it('declares the source repository (npm provenance is generated against it)', () => {
    const repo = (
      pkg as unknown as { repository?: { type: string; url: string } }
    ).repository;
    expect(repo?.url).toContain('github.com/optifeed/optifeed-radar');
  });

  it('points readers at the issue tracker and homepage', () => {
    const p = pkg as unknown as { bugs?: { url: string }; homepage?: string };
    expect(p.bugs?.url).toContain('optifeed-radar');
    expect(p.homepage).toBeTruthy();
  });
});
