/**
 * The `check` command: the full AI Visibility pipeline (M11). THIN over
 * `runCheck` (M10) - it parses flags, builds concrete deps, and renders the
 * returned envelope via M9. No orchestration here (hard rule #1).
 */
import { Command } from 'commander';
import {
  ENGINE_ORDER,
  detectAvailableEngines,
  resolveStateDir,
} from '../core/config.js';
import { CostGuard } from '../core/costs.js';
import {
  failUnder,
  renderCheckHtml,
  renderCheckJson,
  renderCheckText,
  spendLine,
} from '../core/output/index.js';
import {
  buildCheckDeps,
  runCheck,
  selectEngines,
  type ConfirmContext,
  type RunCheckDeps,
} from '../core/run/index.js';
import type { EngineId } from '../core/types.js';
import { createProgressReporter } from './progress.js';
import type { CheckFlags, Runtime } from './runtime.js';

/**
 * Fail loudly on stray positional arguments. Commander already rejects excess
 * args, but with a raw `process.exit` and a generic message; this routes the
 * error through the injected runtime (testable, keeps `--json` stdout clean)
 * and names the offending token. Returns true when a stray arg was found.
 *
 * The common cause (live 2026-07-17): `npm run dev check <domain> --report x`,
 * where npm swallows `--report` and leaves `x` as a bare positional - so the
 * `hint` points back at the flag the user almost certainly meant.
 */
export function rejectStrayArgs(
  rt: Runtime,
  command: Command,
  hint?: string,
): boolean {
  const extra = command.args.slice(command.registeredArguments.length);
  if (extra.length === 0) return false;
  const label = extra.map((a) => `"${a}"`).join(', ');
  rt.err(
    `Unexpected extra argument: ${label}.${hint ? ` ${hint}` : ''}\n` +
      'If you ran this via `npm run dev`, put `--` before the command so npm ' +
      'passes flags through: `npm run dev -- check <domain> --report file.html`.\n',
  );
  process.exitCode = 1;
  return true;
}

/**
 * Parse `--engines a,b` into known engine ids via the shared classifier (same
 * drop-unknown / all-unknown policy the MCP tool uses). An all-unknown value
 * yields `[]`, which the action treats as an error (rather than silently
 * querying - and billing - every engine).
 */
function parseEngines(value: string): EngineId[] {
  const selection = selectEngines(value.split(','));
  return selection.kind === 'engines' ? selection.engines : [];
}

function toFlags(o: Record<string, unknown>): CheckFlags {
  return {
    yes: o.yes as boolean | undefined,
    json: o.json as boolean | undefined,
    report: o.report as string | undefined,
    quick: o.quick as boolean | undefined,
    engines: o.engines as EngineId[] | undefined,
    judge: o.judge as string | undefined,
    maxCost: o.maxCost as number | undefined,
    maxSetupCost: o.maxSetupCost as number | undefined,
    grounded: o.grounded as boolean | undefined,
    failUnder: o.failUnder as number | undefined,
    refresh: o.refresh as boolean | undefined,
    regenerate: o.regenerate as boolean | undefined,
    brand: o.brand as string | undefined,
    category: o.category as string | undefined,
    queries: o.queries as string | undefined,
  };
}

/**
 * Build the real check deps from env + flags. Resolves the judge model (cheapest
 * available, honest notice), wires adapters/guard/fs, and provides a confirm
 * gate that is a no-op abort off a TTY (agents pass `--yes`).
 */
export async function defaultCheckDeps(
  rt: Runtime,
  flags: CheckFlags,
  available: EngineId[],
): Promise<RunCheckDeps> {
  const guard = new CostGuard({
    maxCostUsd: flags.maxCost,
    maxSetupCostUsd: flags.maxSetupCost,
  });

  // Default to ALL engines so keyless ones reach askAll and are surfaced as
  // skippedEngines (honest 1-of-4 reporting); `--engines` narrows the set.
  const { deps, judgeNotice, judgeQualityWarning } = await buildCheckDeps({
    env: rt.env,
    fetcher: rt.fetcher,
    engines: flags.engines as EngineId[] | undefined,
    availableEngines: available,
    judgeModel: flags.judge,
    guard,
    now: () => rt.now(),
  });
  if (judgeNotice) rt.err(`${judgeNotice}\n`);
  // Stderr, like the notice, so `--json` stdout stays a clean envelope.
  if (judgeQualityWarning) rt.err(`${judgeQualityWarning}\n`);

  const confirm = async (ctx: ConfirmContext): Promise<boolean> => {
    const cost = ctx.estimate
      ? `about $${ctx.estimate.totalUsd.toFixed(4)}`
      : 'an unknown amount';
    // Prompt prose goes to stderr so it never pollutes --json on stdout.
    rt.err(
      `This will query ${ctx.engines.length} engines with ${ctx.nPrompts} prompts (estimated cost: ${cost}).\n`,
    );
    if (!rt.isTTY) {
      rt.err('Non-interactive: re-run with --yes to proceed.\n');
      return false;
    }
    const { confirm: ask } = await import('@inquirer/prompts');
    return ask({ message: 'Proceed?', default: false });
  };

  return { ...deps, confirm };
}

/** Register `check <domain>` on the program. */
export function registerCheck(program: Command, rt: Runtime): void {
  program
    .command('check')
    .argument('<domain>', 'the brand site to check, e.g. example.com')
    // Let parsing reach the action so a stray arg gets a helpful, injectable
    // error (rejectStrayArgs) instead of commander's raw process.exit.
    .allowExcessArguments(true)
    .description(
      'Ask real AI engines real buyer questions and score your brand',
    )
    .option('-y, --yes', 'skip the cost confirmation (for AI agents / CI)')
    .option('--json', 'output the raw JSON envelope (no ANSI)')
    .option('--report <file>', 'also write a self-contained HTML report')
    .option('--quick', 'use a smaller prompt pack (8 prompts)')
    .option('--engines <list>', 'comma-separated engines to use', parseEngines)
    .option('--judge <model>', 'judge model for discovery/query-gen/scoring')
    .option('--max-cost <usd>', 'hard cap on total spend', parseFloat)
    .option(
      '--max-setup-cost <usd>',
      'hard cap on discovery/query spend',
      parseFloat,
    )
    .option(
      '--grounded',
      'ask engines in grounded (web-search) mode where supported',
    )
    .option(
      '--fail-under <score>',
      'exit non-zero if the score is under this (CI gate)',
      parseFloat,
    )
    .option('--refresh', 'rediscover the brand profile')
    .option('--regenerate', 'regenerate the query pack')
    .option('--brand <name>', 'set the brand name (skips discovery fetch)')
    .option('--category <name>', 'set the category (skips discovery fetch)')
    .option('--queries <file>', 'use an explicit query pack file')
    .action(async (domain: string, options, command: Command) => {
      // A stray positional is almost always a flag npm swallowed (e.g.
      // `check <domain> file.html` meaning `--report file.html`). Fail before
      // spending, and point at the likely intent.
      if (
        rejectStrayArgs(
          rt,
          command,
          'Did you mean to pass it to a flag such as --report?',
        )
      ) {
        return;
      }

      const flags = toFlags(options as Record<string, unknown>);

      // `--engines` was given but nothing in it was recognized: error rather
      // than silently falling back to querying (and billing) every engine.
      if (flags.engines?.length === 0) {
        rt.err(
          `No recognized engines in --engines. Known engines: ${ENGINE_ORDER.join(', ')}.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const available = detectAvailableEngines(rt.env).filter((e) =>
        flags.engines?.length ? flags.engines.includes(e) : true,
      );
      if (available.length === 0) {
        rt.err(
          `check needs at least one engine API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY).\n` +
            `For a zero-key readiness check, run: audit ${domain}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const deps = rt.checkDeps
        ? rt.checkDeps(flags)
        : await defaultCheckDeps(rt, flags, available);

      // Live progress (spinner + per-prompt list) only on an interactive TTY
      // and never under --json - it writes to stderr so stdout stays pure JSON,
      // and agents/CI (non-TTY) get the clean, quiet path.
      const reporter =
        rt.isTTY && !flags.json
          ? createProgressReporter({ write: (s) => rt.err(s) })
          : undefined;
      if (reporter) deps.onProgress = reporter.onProgress;

      const stateDir = resolveStateDir({
        cwd: rt.cwd,
        homeDir: rt.homeDir,
        domain,
        isProjectWritable: rt.isProjectWritable,
      });

      let result;
      try {
        result = await runCheck(domain, deps, {
          stateDir,
          yes: flags.yes,
          count: flags.quick ? 8 : undefined,
          mode: flags.grounded ? 'grounded' : undefined,
          refresh: flags.refresh,
          regenerate: flags.regenerate,
          brand: flags.brand,
          category: flags.category,
          queriesFile: flags.queries,
        });
      } finally {
        reporter?.stop();
      }

      if (result.aborted) {
        // Under --json, stdout is the envelope channel and nothing else may
        // touch it: an agent that gets prose here cannot tell an abort from a
        // crash. Every other branch already routes prose to stderr; this one
        // did not, and the spend line made it a second offender.
        const say = (s: string): void => {
          if (flags.json) rt.err(s);
          else rt.out(s);
        };
        say('Aborted - no engines were queried.\n');
        // Discovery and query generation bill BEFORE the confirmation gate, so
        // an aborted run is not necessarily a free one. Reported only when it
        // actually cost something, so a genuinely free abort stays quiet.
        const spent = result.spend;
        if (spent && spent.totalUsd > 0) {
          say(`${spendLine(spent)}\n`);
        }
        return;
      }
      const env = result.envelope!;

      // Write the report first, independent of --json, and never let a failed
      // write throw away the paid run's results (report is a best-effort side
      // output). Its confirmation goes to stderr under --json so stdout stays
      // pure JSON.
      let reportWritten: string | undefined;
      if (flags.report) {
        try {
          await rt.writeFile(flags.report, renderCheckHtml(env));
          reportWritten = flags.report;
        } catch (e) {
          rt.err(
            `Could not write report to ${flags.report}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }

      if (flags.json) {
        rt.out(`${renderCheckJson(env)}\n`);
        if (reportWritten) rt.err(`HTML report written to ${reportWritten}\n`);
      } else {
        rt.out(
          `${renderCheckText(env, { reportPath: result.snapshotPath })}\n`,
        );
        if (reportWritten) rt.out(`HTML report written to ${reportWritten}\n`);
      }
      for (const note of result.notes) rt.err(`${note}\n`);

      // THE gate. `failUnder` also fails a run that measured nothing (score
      // null) with no threshold set: the report says "not assessed", but CI and
      // agents read the exit code, and exiting 0 would tell them a total
      // failure passed. Always to stderr, so `--json` stdout stays pure.
      const gate = failUnder(env, flags.failUnder);
      if (flags.failUnder !== undefined || gate.exitCode !== 0) {
        rt.err(`${gate.reason}\n`);
      }
      // Only ever raise the exit code - never reset a failure set upstream.
      if (gate.exitCode !== 0) process.exitCode = gate.exitCode;
    });
}
