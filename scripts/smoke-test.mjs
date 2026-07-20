/**
 * M17 launch smoke test: run the REAL CLI against real domains with real keys.
 *
 * This is the manual pre-release gate. It shells out to the BUILT binary
 * (`dist/cli/index.js`) rather than importing core, so it exercises the same
 * path a user gets - argument parsing, key detection, rendering, exit codes -
 * and not just the library underneath.
 *
 * It spends real money. Every run is capped (`--max-cost`), the estimate is
 * printed before spending, and the actual spend is reported per run and in
 * total, so the gate can never quietly cost more than it claims.
 *
 * Usage:
 *   node scripts/smoke-test.mjs              # audit + parametric checks
 *   node scripts/smoke-test.mjs --grounded   # adds one grounded run
 *   node scripts/smoke-test.mjs --dry-run    # print the plan, spend nothing
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = 'dist/cli/index.js';

/**
 * Domains chosen to exercise DIFFERENT paths, not just three of the same:
 * a widely-known brand (engines should actually recommend it, so a non-zero
 * score proves scoring works end to end), a non-English retailer (locale
 * detection and non-Latin matching), and our own domain (the honest low-score
 * case - a smoke test that only ever sees high scores has not seen much).
 */
const DOMAINS = [
  {
    domain: 'notion.so',
    why: 'well-known brand; expect a real, non-zero score',
  },
  { domain: 'www.do-re.com.tr', why: 'non-English (tr) retailer; locale path' },
  { domain: 'optifeed.com', why: 'our own brand; honest low-score case' },
];

const MAX_COST_PARAMETRIC = 0.6;
const MAX_COST_GROUNDED = 1.2;

/** Load .env without a dependency. Values are never printed (hard rule #4). */
function loadEnv() {
  let raw;
  try {
    raw = readFileSync('.env', 'utf8');
  } catch {
    return; // rely on the ambient environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

async function cli(args) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr, ms: Date.now() - started };
  } catch (err) {
    // A non-zero exit is DATA here, not a crash: --fail-under and
    // "nothing measured" both exit 1 by design.
    return {
      ok: false,
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      ms: Date.now() - started,
    };
  }
}

const usd = (n) => `$${n.toFixed(4)}`;

async function checkDomain({ domain, why }, { grounded }) {
  const label = grounded ? `${domain} (grounded)` : domain;
  console.log(`\n=== ${label} ===\n${why}`);

  const audit = await cli(['audit', domain, '--json']);
  let auditScore = null;
  try {
    auditScore = JSON.parse(audit.stdout).score;
  } catch {
    /* reported below as a failure */
  }
  console.log(
    `  audit: ${audit.ok ? `score ${auditScore}/100` : `FAILED (exit ${audit.code})`} in ${audit.ms}ms`,
  );

  const args = [
    'check',
    domain,
    '--quick',
    '--yes',
    '--json',
    '--max-cost',
    String(grounded ? MAX_COST_GROUNDED : MAX_COST_PARAMETRIC),
  ];
  if (grounded) args.push('--grounded');

  const res = await cli(args);
  let env = null;
  try {
    env = JSON.parse(res.stdout);
  } catch {
    console.log(`  check: UNPARSEABLE JSON (exit ${res.code})`);
    console.log(`  stderr: ${res.stderr.slice(0, 400)}`);
    return { domain: label, failed: true, spend: 0 };
  }

  const spend = env.spend?.totalUsd ?? 0;
  const answerSum = (env.answers ?? []).reduce(
    (s, a) => s + (a.costUsd ?? 0),
    0,
  );
  // Search counts MUST be reported per engine, not pooled. The per-search fee
  // is engine-specific (only Gemini bills it today), and a pooled figure mixes
  // in engines that either do not charge per search or do not report their
  // queries at all - which is exactly how the first run of this script
  // produced a misleading "n=8" that was really 7 Gemini calls plus 1 OpenAI.
  const searchesByEngine = {};
  for (const a of env.answers ?? []) {
    const n = a.fanoutQueries?.length ?? 0;
    if (n > 0) (searchesByEngine[a.engine] ??= []).push(n);
  }

  console.log(
    `  check: score ${env.score === null ? 'not assessed' : `${env.score}/100`}` +
      ` over ${env.answers?.length ?? 0} answers in ${(res.ms / 1000).toFixed(1)}s (exit ${res.code})`,
  );
  console.log(
    `  spend: ${usd(spend)} reported` +
      (env.spend
        ? ` = setup ${usd(env.spend.setupUsd)} + engines ${usd(env.spend.mainUsd)}`
        : ' (NO spend field - regression)'),
  );
  // Internal consistency: engine-phase spend should equal the answers it paid
  // for, plus any scoring-judge calls. It must never be LESS.
  console.log(
    `  answers sum ${usd(answerSum)} vs engine phase ${usd(env.spend?.mainUsd ?? 0)}` +
      ((env.spend?.mainUsd ?? 0) + 1e-9 >= answerSum
        ? ' [consistent]'
        : ' [UNDER-REPORTED]'),
  );

  const honesty = [
    env.costCapped ? 'costCapped' : null,
    env.degraded ? 'degraded' : null,
    env.skippedEngines?.length
      ? `skipped=${env.skippedEngines.map((s) => s.engine).join('/')}`
      : null,
    env.partialEngines?.length
      ? `partial=${env.partialEngines.map((p) => `${p.engine} ${p.answered}/${p.attempted}`).join(', ')}`
      : null,
  ].filter(Boolean);
  console.log(
    `  honesty: ${honesty.length ? honesty.join('; ') : 'clean run'}`,
  );

  for (const [engine, counts] of Object.entries(searchesByEngine)) {
    const total = counts.reduce((a, b) => a + b, 0);
    const sorted = [...counts].sort((a, b) => a - b);
    console.log(
      `  ${engine} searches/call: ${counts.join(',')}` +
        ` (n=${counts.length}, median ${sorted[Math.floor(sorted.length / 2)]}, mean ${(total / counts.length).toFixed(2)}, total ${total})`,
    );
  }

  // An engine asked in grounded mode that ran NO search and returned NO
  // citations answered from its own weights: it is parametric in substance
  // whatever it is tagged, and the 1.5x grounded weight in the composite is
  // unearned. Surfaced here because only a live run can reveal it.
  const unsubstantiated = {};
  for (const a of env.answers ?? []) {
    if (a.kind !== 'grounded') continue;
    if (
      (a.fanoutQueries?.length ?? 0) === 0 &&
      (a.citations?.length ?? 0) === 0
    ) {
      unsubstantiated[a.engine] = (unsubstantiated[a.engine] ?? 0) + 1;
    }
  }
  for (const [engine, n] of Object.entries(unsubstantiated)) {
    const of = (env.answers ?? []).filter((a) => a.engine === engine).length;
    console.log(
      `  WARN ${engine}: ${n}/${of} answers tagged grounded with no search and no citation`,
    );
  }

  return { domain: label, failed: !env, spend, searchesByEngine };
}

async function main() {
  const grounded = process.argv.includes('--grounded');
  const dryRun = process.argv.includes('--dry-run');
  loadEnv();

  const keys = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'PERPLEXITY_API_KEY',
  ];
  const present = keys.filter((k) => process.env[k]);
  console.log(
    `Keys present: ${present.length}/4 (${present.join(', ') || 'none'})`,
  );
  const worstCase =
    DOMAINS.length * MAX_COST_PARAMETRIC + (grounded ? MAX_COST_GROUNDED : 0);
  console.log(
    `Plan: audit + check --quick on ${DOMAINS.length} domains${grounded ? ' + 1 grounded run' : ''}.`,
  );
  console.log(
    `Hard ceiling from --max-cost: ${usd(worstCase)} (actual will be lower).\n`,
  );
  if (dryRun) {
    for (const d of DOMAINS)
      console.log(`  would check ${d.domain} - ${d.why}`);
    return;
  }

  const results = [];
  for (const d of DOMAINS)
    results.push(await checkDomain(d, { grounded: false }));
  if (grounded) {
    results.push(await checkDomain(DOMAINS[0], { grounded: true }));
  }

  const total = results.reduce((s, r) => s + r.spend, 0);
  console.log('\n=== summary ===');
  for (const r of results) {
    console.log(
      `  ${r.failed ? 'FAIL' : 'ok  '}  ${r.domain.padEnd(30)} ${usd(r.spend)}`,
    );
  }
  console.log(`  TOTAL SPEND: ${usd(total)}`);

  // Per engine, so the figure can be compared against the right pricing row.
  const pooled = {};
  for (const r of results) {
    for (const [engine, counts] of Object.entries(r.searchesByEngine ?? {})) {
      (pooled[engine] ??= []).push(...counts);
    }
  }
  for (const [engine, counts] of Object.entries(pooled)) {
    const sorted = [...counts].sort((a, b) => a - b);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    console.log(
      `  ${engine} searches/call: n=${counts.length}, median ${sorted[Math.floor(sorted.length / 2)]},` +
        ` mean ${mean.toFixed(2)}, max ${sorted[sorted.length - 1]}` +
        ' (compare with ESTIMATE_ASSUMPTIONS.searchesPerGroundedCall)',
    );
  }
}

await main();
