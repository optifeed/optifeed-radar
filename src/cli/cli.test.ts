import { afterEach, describe, expect, it } from 'vitest';
import { createFetcher, type FetchLike } from '../core/fetcher/index.js';
import type { EngineAdapter } from '../core/engines/index.js';
import { profilePath, type ProfileFs } from '../core/discovery/index.js';
import { queriesPath, toYaml, type QueryFs } from '../core/queries/index.js';
import type { SnapshotFs } from '../core/output/index.js';
import type { RunCheckDeps } from '../core/run/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
  type QueryPack,
} from '../core/types.js';
import { buildProgram } from './index.js';
import { type Runtime } from './runtime.js';

const STATE = '/proj/.optifeed';
const NOW = () => '2026-07-15T00:00:00.000Z';

function res(body: string, status = 200) {
  return {
    status,
    headers: { get: () => 'text/html' },
    text: async () => body,
  };
}
const fakeFetch: FetchLike = async (url) => {
  const u = url.replace(/\/$/, '');
  if (u.endsWith('robots.txt')) return res('User-agent: GPTBot\nDisallow: /');
  if (
    u.endsWith('llms.txt') ||
    u.endsWith('llms-full.txt') ||
    u.endsWith('sitemap.xml')
  )
    return res('nf', 404);
  return res('<html><head><title>Acme</title></head><body>Acme</body></html>');
};

function adapter(id: EngineId, kind: EngineKind): EngineAdapter {
  return {
    id,
    kind,
    model: `${id}-model`,
    available: () => true,
    ask: async (prompt): Promise<EngineAnswer> => ({
      engine: id,
      kind,
      prompt,
      text: 'Acme is a great widget brand.',
      model: `${id}-model`,
      costUsd: 0.0001,
      ts: NOW(),
    }),
  };
}

const judge: JudgeClient = {
  model: 'judge-model',
  complete: async () => ({ text: '{}', costUsd: 0, model: 'judge-model' }),
};

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme',
  aliases: [],
  competitors: ['Globex'],
};
const PACK: QueryPack = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  queries: [{ id: 'q1', intent: 'best-of', prompt: 'best widgets brand?' }],
};

function memFs(
  seed: Record<string, string> = {},
): ProfileFs & QueryFs & SnapshotFs {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const nf = (): never => {
    const e = new Error('ENOENT') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    throw e;
  };
  return {
    async readFile(p: string) {
      return files.get(p) ?? nf();
    },
    async writeFile(p: string, d: string) {
      files.set(p, d);
    },
    async mkdir(p: string) {
      dirs.add(p);
    },
    async readdir(p: string) {
      if (!dirs.has(p)) nf();
      return [...files.keys()]
        .filter((f) => f.startsWith(`${p}/`))
        .map((f) => f.slice(p.length + 1));
    },
  };
}

/** A runtime capturing output, with the check pipeline fully mocked. */
function testRuntime(over: Partial<Runtime> = {}): Runtime & {
  output: string[];
  errors: string[];
  reports: Map<string, string>;
} {
  const output: string[] = [];
  const errors: string[] = [];
  const reports = new Map<string, string>();
  const fs = memFs({
    [profilePath(STATE)]: JSON.stringify(PROFILE),
    [queriesPath(STATE)]: toYaml(PACK),
  });
  const checkDeps = (): RunCheckDeps => ({
    fetcher: createFetcher({ fetchImpl: fakeFetch }),
    adapters: [adapter('openai', 'parametric')],
    judge,
    profileFs: fs,
    queryFs: fs,
    snapshotFs: fs,
    now: NOW,
  });
  return {
    output,
    errors,
    reports,
    out: (s) => output.push(s),
    err: (s) => errors.push(s),
    env: {},
    cwd: '/proj',
    homeDir: '/home',
    isTTY: false,
    isProjectWritable: true,
    now: NOW,
    writeFile: async (p, d) => {
      reports.set(p, d);
    },
    fetcher: createFetcher({ fetchImpl: fakeFetch }),
    checkDeps,
    ...over,
  };
}

function run(rt: Runtime, args: string[]): Promise<unknown> {
  return buildProgram(rt).parseAsync(args, { from: 'user' });
}

afterEach(() => {
  process.exitCode = 0;
});

describe('audit command (zero-key)', () => {
  it('runs with no keys and prints score + footer', async () => {
    const rt = testRuntime();
    await run(rt, ['audit', 'acme.example']);
    const out = rt.output.join('');
    expect(out).toContain('/100');
    expect(out).toContain('optifeed.com');
    // GPTBot disallowed in the fake robots -> a finding surfaces.
    expect(out.toLowerCase()).toContain('gptbot');
  });

  it('emits raw JSON under --json', async () => {
    const rt = testRuntime();
    await run(rt, ['audit', 'acme.example', '--json']);
    const parsed = JSON.parse(rt.output.join(''));
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.domain).toBe('acme.example');
  });
});

describe('check command', () => {
  it('runs the pipeline with a key and prints the visibility score', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['check', 'acme.example', '--yes']);
    const out = rt.output.join('');
    expect(out).toContain('AI Visibility Score');
    expect(out).toContain('Acme');
    expect(out).toContain('optifeed.com');
  });

  it('emits a clean JSON envelope under --json (no ANSI)', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['check', 'acme.example', '--yes', '--json']);
    const out = rt.output.join('');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
    const env = JSON.parse(out);
    expect(env.schema_version).toBe(SCHEMA_VERSION);
    expect(typeof env.score).toBe('number');
  });

  it('writes an HTML report under --report', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['check', 'acme.example', '--yes', '--report', 'out.html']);
    expect(rt.reports.get('out.html')).toContain('<!doctype html>');
    expect(rt.output.join('')).toContain('out.html');
  });

  it('refuses without any engine key and points to audit (exit 1)', async () => {
    const rt = testRuntime({ env: {} });
    await run(rt, ['check', 'acme.example', '--yes']);
    expect(rt.errors.join('')).toContain('audit acme.example');
    expect(process.exitCode).toBe(1);
  });
});
