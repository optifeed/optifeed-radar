import { afterEach, describe, expect, it } from 'vitest';
import { CostGuard } from '../core/costs.js';
import { createFetcher, type FetchLike } from '../core/fetcher/index.js';
import type { EngineAdapter } from '../core/engines/index.js';
import { profilePath, type ProfileFs } from '../core/discovery/index.js';
import {
  queriesPath,
  saveQueryPack,
  toYaml,
  type QueryFs,
} from '../core/queries/index.js';
import {
  saveSnapshot,
  type SnapshotFs,
  type VisibilityEnvelope,
} from '../core/output/index.js';
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
import { defaultCheckDeps } from './check.js';
import { type Runtime } from './runtime.js';

// The project state dir is DOMAIN-SCOPED (commit c3cc7cc), so a run for
// acme.example reads `<cwd>/.optifeed/acme.example`. These seeds previously
// used the un-scoped `/proj/.optifeed`, so `check` never found them: it fell
// through to generation, the stub judge returned `{}` = ZERO queries, and the
// whole "mocked e2e" ran on 0 prompts / 0 answers. It looked green only because
// the composite then fabricated a 0, which satisfied `typeof score === 'number'`.
// Seed the scoped path so these tests exercise the real pipeline.
const STATE = '/proj/.optifeed/acme.example';
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
function testRuntime(
  over: Partial<Runtime> = {},
  seed: Record<string, string> = {},
): Runtime & {
  output: string[];
  errors: string[];
  reports: Map<string, string>;
  fs: ReturnType<typeof memFs>;
} {
  const output: string[] = [];
  const errors: string[] = [];
  const reports = new Map<string, string>();
  const fs = memFs({
    [profilePath(STATE)]: JSON.stringify(PROFILE),
    [queriesPath(STATE)]: toYaml(PACK),
    ...seed,
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
    fs,
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
    snapshotFs: fs,
    queryFs: fs,
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

  // A run that spends money says what it spent, in the report a human reads.
  it('prints what the run cost', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['check', 'acme.example', '--yes']);
    expect(rt.output.join('')).toContain('Run cost: $');
  });

  // Discovery and query generation bill BEFORE the confirm gate, so an aborted
  // run is not necessarily a free one. Saying only "no engines were queried"
  // would let a user who declined to avoid spending believe it cost nothing.
  it('reports setup spend when the run is aborted at the confirm gate', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    const guard = new CostGuard();
    guard.record(0.02, 'setup');
    // Reuse the standard deps and only add the guard + a declining gate, so
    // this test does not re-specify the whole pipeline.
    // Must stay SYNC: `rt.checkDeps(flags)` is not awaited, so an async
    // override would hand runCheck a Promise and fall through to the real
    // network fetcher.
    const base = rt.checkDeps!;
    rt.checkDeps = (...args: Parameters<typeof base>) => ({
      ...base(...args),
      guard,
      confirm: async () => false,
    });

    await run(rt, ['check', 'acme.example']);
    const all = rt.output.join('') + rt.errors.join('');
    expect(all).toContain('Aborted');
    expect(all).toContain('$0.0200');
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
    // Assert the pipeline actually RAN. `typeof score === 'number'` alone was
    // satisfied by a fabricated 0 over 0 answers for as long as this test has
    // existed - a green e2e over an empty run. Pin the evidence instead.
    expect(env.answers.length).toBeGreaterThan(0);
    expect(env.engines.length).toBeGreaterThan(0);
    expect(env.sampling.nPrompts).toBeGreaterThan(0);
  });

  // `--fail-under` is the CI gate the plan requires (dev-plan M8: "Exit codes:
  // --fail-under <n> (CI mode)"). failUnder() was built, tested and exported at
  // M8 but had NO call site until 2026-07-17, so the flag did not exist and
  // nothing ever gated on score - review lesson #3 (an enforcement API must
  // land with its consumer), the third instance after CostGuard.authorize and
  // this.
  describe('--fail-under gate', () => {
    /** A runtime whose engine answers without ever naming the brand -> score 0. */
    function unmentionedRuntime() {
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      const silent: EngineAdapter = {
        id: 'openai',
        kind: 'parametric',
        model: 'openai-model',
        available: () => true,
        ask: async (prompt): Promise<EngineAnswer> => ({
          engine: 'openai',
          kind: 'parametric',
          prompt,
          text: 'Globex and Initech are the leading widget brands.',
          model: 'openai-model',
          costUsd: 0.0001,
          ts: NOW(),
        }),
      };
      rt.checkDeps = () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch }),
        adapters: [silent],
        judge,
        profileFs: rt.fs,
        queryFs: rt.fs,
        snapshotFs: rt.fs,
        now: NOW,
      });
      return rt;
    }

    it('exits 1 and explains when the score is under the threshold', async () => {
      const rt = unmentionedRuntime(); // brand never mentioned -> score 0
      await run(rt, ['check', 'acme.example', '--yes', '--fail-under', '50']);
      expect(process.exitCode).toBe(1);
      expect(rt.errors.join('').toLowerCase()).toContain('under the');
    });

    it('exits 0 when the score meets the threshold', async () => {
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      await run(rt, ['check', 'acme.example', '--yes', '--fail-under', '1']);
      expect(process.exitCode).toBe(0);
    });

    it('exits 0 and stays quiet when no threshold is given', async () => {
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      await run(rt, ['check', 'acme.example', '--yes']);
      expect(process.exitCode).toBe(0);
      // No gate was requested, so do not narrate one on every healthy run.
      expect(rt.errors.join('').toLowerCase()).not.toContain('threshold');
    });

    it('keeps --json stdout pure: the gate reason goes to stderr', async () => {
      const rt = unmentionedRuntime();
      await run(rt, [
        'check',
        'acme.example',
        '--yes',
        '--json',
        '--fail-under',
        '50',
      ]);
      expect(() => JSON.parse(rt.output.join(''))).not.toThrow();
      expect(rt.errors.join('').toLowerCase()).toContain('under the');
    });
  });

  // A run that measured nothing must not signal success. The report already
  // says "not assessed", but CI and agents read the EXIT CODE - exiting 0 tells
  // them a total failure passed. This holds with no --fail-under at all: it is
  // not a threshold judgement, it is "nothing was measured".
  describe('not-assessed runs exit non-zero', () => {
    const deadAdapter = (): EngineAdapter => ({
      id: 'openai',
      kind: 'parametric',
      model: 'openai-model',
      available: () => true,
      ask: () => Promise.reject(new Error('401 invalid api key')),
    });

    it('exits 1 when no engine answered, even without --fail-under', async () => {
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      rt.checkDeps = () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch }),
        adapters: [deadAdapter()],
        judge,
        profileFs: rt.fs,
        queryFs: rt.fs,
        snapshotFs: rt.fs,
        now: NOW,
      });
      await run(rt, ['check', 'acme.example', '--yes']);
      expect(process.exitCode).toBe(1);
      const all = rt.output.join('') + rt.errors.join('');
      expect(all.toLowerCase()).toContain('not assessed');
    });
  });

  // --grounded is the CLI surface for grounded mode. runCheck already threads
  // `mode` through to every adapter; without a flag setting it, OpenAI's
  // web_search and Gemini grounding paths were dead code at runtime (third
  // build-without-a-call-site). This asserts the flag reaches the adapter.
  describe('--grounded selects grounded mode', () => {
    function recordingAdapter(modes: (string | undefined)[]): EngineAdapter {
      return {
        id: 'openai',
        kind: 'parametric',
        model: 'openai-model',
        available: () => true,
        ask: async (prompt, opts): Promise<EngineAnswer> => {
          modes.push(opts?.mode);
          return {
            engine: 'openai',
            kind: opts?.mode ?? 'parametric',
            prompt,
            text: 'Acme is a great widget brand.',
            model: 'openai-model',
            costUsd: 0.0001,
            ts: NOW(),
          };
        },
      };
    }

    it('asks the engine in grounded mode', async () => {
      const modes: (string | undefined)[] = [];
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      rt.checkDeps = () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch }),
        adapters: [recordingAdapter(modes)],
        judge,
        profileFs: rt.fs,
        queryFs: rt.fs,
        snapshotFs: rt.fs,
        now: NOW,
      });
      await run(rt, ['check', 'acme.example', '--yes', '--grounded']);
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((m) => m === 'grounded')).toBe(true);
    });

    it('leaves mode unset without the flag (engine default)', async () => {
      const modes: (string | undefined)[] = [];
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      rt.checkDeps = () => ({
        fetcher: createFetcher({ fetchImpl: fakeFetch }),
        adapters: [recordingAdapter(modes)],
        judge,
        profileFs: rt.fs,
        queryFs: rt.fs,
        snapshotFs: rt.fs,
        now: NOW,
      });
      await run(rt, ['check', 'acme.example', '--yes']);
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((m) => m === undefined)).toBe(true);
    });
  });

  // Live 2026-07-17: `npm run dev check <domain> dore.html` - the user meant
  // `--report dore.html` but npm swallowed the flag, leaving `dore.html` as a
  // stray positional. `check` accepted it, ran, and SPENT money while silently
  // ignoring the argument. A stray arg is a mistake; fail loudly, before spend.
  describe('rejects stray arguments', () => {
    it('errors (exit 1) and does not run when given an extra positional', async () => {
      const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
      await run(rt, ['check', 'acme.example', 'dore.html']);
      expect(process.exitCode).toBe(1);
      const err = rt.errors.join('').toLowerCase();
      expect(err).toContain('dore.html'); // name the offending arg
      expect(err).toContain('--report'); // point at the likely intent
      // It must NOT have produced a report: no spend, no output.
      expect(rt.output.join('')).not.toContain('AI Visibility Score');
    });

    it('audit also rejects a stray positional', async () => {
      const rt = testRuntime();
      await run(rt, ['audit', 'acme.example', 'extra']);
      expect(process.exitCode).toBe(1);
      expect(rt.errors.join('').toLowerCase()).toContain('extra');
      expect(rt.output.join('')).not.toContain('/100');
    });
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

  it('errors on an unrecognized --engines value instead of billing every engine', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['check', 'acme.example', '--yes', '--engines', 'opnai']);
    expect(rt.errors.join('').toLowerCase()).toContain('engine');
    expect(process.exitCode).toBe(1);
    // Nothing rendered - it did not silently fall back to all engines.
    expect(rt.output.join('')).not.toContain('AI Visibility Score');
  });

  it('writes the HTML report AND prints JSON when both are requested', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, [
      'check',
      'acme.example',
      '--yes',
      '--json',
      '--report',
      'out.html',
    ]);
    expect(rt.reports.get('out.html')).toContain('<!doctype html>');
    expect(() => JSON.parse(rt.output.join(''))).not.toThrow();
  });

  it('still prints the paid results if the report write fails', async () => {
    const rt = testRuntime({
      env: { OPENAI_API_KEY: 'sk-test' },
      writeFile: async () => {
        throw new Error('ENOENT: no such directory');
      },
    });
    await run(rt, [
      'check',
      'acme.example',
      '--yes',
      '--report',
      '/nope/out.html',
    ]);
    expect(rt.output.join('')).toContain('AI Visibility Score');
    expect(rt.errors.join('').toLowerCase()).toContain('report');
  });
});

// The domain-scoped state dir the inspect commands resolve for acme.example
// (cwd /proj, project writable): `<cwd>/.optifeed/<domain>`.
const DSTATE = '/proj/.optifeed/acme.example';

function snapEnvelope(
  over: Partial<VisibilityEnvelope> = {},
): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: '2026-07-15T00:00:00.000Z',
    domain: 'acme.example',
    profile: PROFILE,
    score: 57,
    engines: [
      {
        engine: 'openai',
        kind: 'parametric',
        score: 60,
        mentionRate: 0.5,
        avgPosition: 1,
        answers: 2,
        mentions: 1,
      },
    ],
    shareOfVoice: [
      { name: 'Acme', isBrand: true, mentions: 2, sharePct: 66.7 },
      { name: 'Globex', isBrand: false, mentions: 1, sharePct: 33.3 },
    ],
    sources: [{ domain: 'eater.com', count: 2 }],
    mentions: [],
    answers: [],
    findings: [],
    sampling: { nPrompts: 1, nAnswers: 2, judged: 0, varianceNote: 'note' },
    ...over,
  };
}

describe('diff command', () => {
  it('diffs the latest two snapshots and prints the signed score delta', async () => {
    const rt = testRuntime();
    await saveSnapshot(
      snapEnvelope({ generatedAt: '2026-07-10T00:00:00.000Z', score: 50 }),
      DSTATE,
      rt.fs,
    );
    await saveSnapshot(snapEnvelope({ score: 57 }), DSTATE, rt.fs);

    await run(rt, ['diff', 'acme.example']);
    const out = rt.output.join('');
    expect(out).toContain('+7'); // 57 - 50
    expect(out).toContain('acme.example');
    expect(out).toContain('optifeed.com');
  });

  it('emits the diff as JSON under --json (carries schema_version)', async () => {
    const rt = testRuntime();
    await saveSnapshot(
      snapEnvelope({ generatedAt: '2026-07-10T00:00:00.000Z', score: 50 }),
      DSTATE,
      rt.fs,
    );
    await saveSnapshot(snapEnvelope({ score: 57 }), DSTATE, rt.fs);

    await run(rt, ['diff', 'acme.example', '--json']);
    const parsed = JSON.parse(rt.output.join(''));
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.scoreDelta).toBe(7);
  });

  it('errors when fewer than two snapshots exist (exit 1)', async () => {
    const rt = testRuntime();
    await saveSnapshot(snapEnvelope(), DSTATE, rt.fs);

    await run(rt, ['diff', 'acme.example']);
    expect(process.exitCode).toBe(1);
    expect(rt.errors.join('').toLowerCase()).toContain('two snapshots');
  });
});

describe('sources command', () => {
  it('shows cited sources and share of voice from the latest snapshot', async () => {
    const rt = testRuntime();
    await saveSnapshot(snapEnvelope(), DSTATE, rt.fs);

    await run(rt, ['sources', 'acme.example']);
    const out = rt.output.join('');
    expect(out).toContain('eater.com');
    expect(out).toContain('(you)');
    expect(out).toContain('optifeed.com');
  });

  it('errors when no snapshot exists yet (exit 1)', async () => {
    const rt = testRuntime();
    await run(rt, ['sources', 'acme.example']);
    expect(process.exitCode).toBe(1);
    expect(rt.errors.join('').toLowerCase()).toContain('check acme.example');
  });

  it('surfaces honesty flags under --json for a partial run (rule #6)', async () => {
    const rt = testRuntime();
    await saveSnapshot(
      snapEnvelope({
        degraded: true,
        skippedEngines: [{ engine: 'gemini', reason: 'no key' }],
      }),
      DSTATE,
      rt.fs,
    );

    await run(rt, ['sources', 'acme.example', '--json']);
    const parsed = JSON.parse(rt.output.join(''));
    expect(parsed.degraded).toBe(true);
    expect(parsed.skippedEngines).toEqual([
      { engine: 'gemini', reason: 'no key' },
    ]);
  });

  // This path hand-rolled its own honesty allowlist, so `partialEngines` (the
  // fourth signal) was dropped: `sources --json` emitted a payload with ZERO
  // honesty keys for a run the text renderer described as partial. Two
  // renderings of one snapshot disagreeing about whether the run was complete
  // is the M8 lesson verbatim. Share of voice is a cross-engine RATIO, so an
  // engine that answered 1 of 8 skews it harder than one skipped outright.
  it('carries partialEngines under --json when it is the only honesty signal', async () => {
    const rt = testRuntime();
    await saveSnapshot(
      snapEnvelope({
        partialEngines: [
          {
            engine: 'gemini',
            attempted: 8,
            answered: 1,
            reason: 'HTTP 429: quota exceeded',
          },
        ],
      }),
      DSTATE,
      rt.fs,
    );

    await run(rt, ['sources', 'acme.example', '--json']);
    const parsed = JSON.parse(rt.output.join(''));
    expect(parsed.partialEngines).toEqual([
      {
        engine: 'gemini',
        attempted: 8,
        answered: 1,
        reason: 'HTTP 429: quota exceeded',
      },
    ]);
  });
});

describe('queries command', () => {
  it('prints the persisted query pack for the domain', async () => {
    const rt = testRuntime();
    await saveQueryPack(PACK, DSTATE, rt.fs);

    await run(rt, ['queries', 'acme.example']);
    expect(rt.output.join('')).toContain('best widgets brand?');
  });

  it('exports the pack to a file under --export', async () => {
    const rt = testRuntime();
    await saveQueryPack(PACK, DSTATE, rt.fs);

    await run(rt, ['queries', 'acme.example', '--export', 'pack.yml']);
    expect(rt.reports.get('pack.yml')).toContain('best widgets brand?');
  });

  it('errors when no pack exists for the domain (exit 1)', async () => {
    // Use a domain the runtime seeds nothing for: testRuntime now seeds the
    // DOMAIN-SCOPED acme.example paths, so asking for acme.example here would
    // find a pack and stop testing the empty case.
    const rt = testRuntime();
    await run(rt, ['queries', 'nopack.example']);
    expect(process.exitCode).toBe(1);
    expect(rt.errors.join('').toLowerCase()).toContain('check nopack.example');
  });
});

describe('config command', () => {
  it('shows which engine keys are set without printing the key values (rule #4)', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-secret-123' } });
    await run(rt, ['config']);
    const out = rt.output.join('');
    expect(out).toContain('openai');
    expect(out.toLowerCase()).toContain('set');
    expect(out).not.toContain('sk-secret-123'); // never leak the key
    expect(out).toContain('.optifeed'); // shows the state directory
  });

  it('reports no engines configured when the env is empty', async () => {
    const rt = testRuntime({ env: {} });
    await run(rt, ['config']);
    expect(rt.output.join('').toLowerCase()).toContain('not set');
  });

  // `config` is where a user goes to see which judge they will get, so it is
  // exactly where a measured quality problem must not be dropped (rule #6 -
  // honesty propagates to every derived artifact).
  it('surfaces a measured-poor judge alongside the resolved model', async () => {
    const rt = testRuntime({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await run(rt, ['config']);
    const out = rt.output.join('');
    expect(out).toContain('claude-sonnet-5');
    expect(out).toMatch(/recall/i);
  });

  it('stays quiet about judge quality for a measured-good judge', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    await run(rt, ['config']);
    expect(rt.output.join('')).not.toMatch(/recall/i);
  });
});

describe('defaultCheckDeps engine selection', () => {
  it('builds adapters for ALL engines (not just keyed ones) so keyless engines surface as skipped', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    const deps = await defaultCheckDeps(rt, {}, ['openai']);
    // All four adapters are present; the three keyless ones are unavailable and
    // askAll will move them to skippedEngines (honest 1-of-4 reporting).
    expect(deps.adapters).toHaveLength(4);
    const unavailable = deps.adapters!.filter((a) => !a.available());
    expect(unavailable.map((a) => a.id).sort()).toEqual([
      'anthropic',
      'gemini',
      'perplexity',
    ]);
  });

  it('restricts to the requested engines when --engines is given', async () => {
    const rt = testRuntime({
      env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-test' },
    });
    const deps = await defaultCheckDeps(rt, { engines: ['openai'] }, [
      'openai',
    ]);
    expect(deps.adapters!.map((a) => a.id)).toEqual(['openai']);
  });
});
