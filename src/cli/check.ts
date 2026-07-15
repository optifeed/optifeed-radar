/**
 * The `check` command: the full AI Visibility pipeline (M11). THIN over
 * `runCheck` (M10) - it parses flags, builds concrete deps, and renders the
 * returned envelope via M9. No orchestration here (hard rule #1).
 */
import { Command } from 'commander';
import {
  DEFAULT_JUDGE_MODELS,
  detectAvailableEngines,
  resolveJudgeModel,
  resolveStateDir,
} from '../core/config.js';
import { CostGuard } from '../core/costs.js';
import {
  createEngineAdapters,
  createJudgeClient,
} from '../core/engines/index.js';
import { nodeProfileFs } from '../core/discovery/index.js';
import { nodeQueryFs } from '../core/queries/index.js';
import {
  nodeSnapshotFs,
  renderCheckHtml,
  renderCheckJson,
  renderCheckText,
} from '../core/output/index.js';
import {
  runCheck,
  type ConfirmContext,
  type RunCheckDeps,
} from '../core/run/index.js';
import type { EngineId } from '../core/types.js';
import type { CheckFlags, Runtime } from './runtime.js';

const ENGINE_IDS: EngineId[] = ['openai', 'anthropic', 'gemini', 'perplexity'];

function parseEngines(value: string): EngineId[] {
  const wanted = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const known = wanted.filter((e): e is EngineId =>
    (ENGINE_IDS as string[]).includes(e),
  );
  return known;
}

function toFlags(o: Record<string, unknown>): CheckFlags {
  return {
    yes: o.yes as boolean | undefined,
    json: o.json as boolean | undefined,
    report: o.report as string | undefined,
    quick: o.quick as boolean | undefined,
    engines: o.engines as EngineId[] | undefined,
    maxCost: o.maxCost as number | undefined,
    maxSetupCost: o.maxSetupCost as number | undefined,
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
async function defaultCheckDeps(
  rt: Runtime,
  flags: CheckFlags,
  available: EngineId[],
): Promise<RunCheckDeps> {
  const wanted = flags.engines?.length ? flags.engines : available;
  const adapters = createEngineAdapters({ env: rt.env }).filter((a) =>
    wanted.includes(a.id),
  );

  const judgeRes = await resolveJudgeModel({
    interactive: false,
    availableEngines: available,
  });
  if (judgeRes.notice) rt.err(`${judgeRes.notice}\n`);
  const judgeEngine =
    ENGINE_IDS.find((e) => DEFAULT_JUDGE_MODELS[e] === judgeRes.model) ??
    available[0]!;
  const judgeAdapter = createEngineAdapters({
    env: rt.env,
    models: { [judgeEngine]: judgeRes.model },
  }).find((a) => a.id === judgeEngine)!;

  const guard = new CostGuard({
    maxCostUsd: flags.maxCost,
    maxSetupCostUsd: flags.maxSetupCost,
  });

  const confirm = async (ctx: ConfirmContext): Promise<boolean> => {
    const cost = ctx.estimate
      ? `about $${ctx.estimate.totalUsd.toFixed(4)}`
      : 'an unknown amount';
    rt.out(
      `This will query ${ctx.engines.length} engines with ${ctx.nPrompts} prompts (estimated cost: ${cost}).\n`,
    );
    if (!rt.isTTY) {
      rt.err('Non-interactive: re-run with --yes to proceed.\n');
      return false;
    }
    const { confirm: ask } = await import('@inquirer/prompts');
    return ask({ message: 'Proceed?', default: false });
  };

  return {
    fetcher: rt.fetcher,
    adapters,
    judge: createJudgeClient(judgeAdapter),
    guard,
    profileFs: nodeProfileFs(),
    queryFs: nodeQueryFs(),
    snapshotFs: nodeSnapshotFs(),
    now: () => rt.now(),
    confirm,
  };
}

/** Register `check <domain>` on the program. */
export function registerCheck(program: Command, rt: Runtime): void {
  program
    .command('check')
    .argument('<domain>', 'the brand site to check, e.g. example.com')
    .description(
      'Ask real AI engines real buyer questions and score your brand',
    )
    .option('-y, --yes', 'skip the cost confirmation (for agents / CI)')
    .option('--json', 'output the raw JSON envelope (no ANSI)')
    .option('--report <file>', 'also write a self-contained HTML report')
    .option('--quick', 'use a smaller prompt pack (8 prompts)')
    .option('--engines <list>', 'comma-separated engines to use', parseEngines)
    .option('--max-cost <usd>', 'hard cap on total spend', parseFloat)
    .option(
      '--max-setup-cost <usd>',
      'hard cap on discovery/query spend',
      parseFloat,
    )
    .option('--refresh', 'rediscover the brand profile')
    .option('--regenerate', 'regenerate the query pack')
    .option('--brand <name>', 'set the brand name (skips discovery fetch)')
    .option('--category <name>', 'set the category (skips discovery fetch)')
    .option('--queries <file>', 'use an explicit query pack file')
    .action(async (domain: string, options: Record<string, unknown>) => {
      const flags = toFlags(options);

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

      const stateDir = resolveStateDir({
        cwd: rt.cwd,
        homeDir: rt.homeDir,
        domain,
        isProjectWritable: rt.isProjectWritable,
      });

      const result = await runCheck(domain, deps, {
        stateDir,
        yes: flags.yes,
        count: flags.quick ? 8 : undefined,
        refresh: flags.refresh,
        regenerate: flags.regenerate,
        brand: flags.brand,
        category: flags.category,
        queriesFile: flags.queries,
      });

      if (result.aborted) {
        rt.out('Aborted - no engines were queried.\n');
        return;
      }
      const env = result.envelope!;

      if (flags.json) {
        rt.out(`${renderCheckJson(env)}\n`);
        return;
      }

      if (flags.report) {
        await rt.writeFile(flags.report, renderCheckHtml(env));
        rt.out(`HTML report written to ${flags.report}\n`);
      }
      rt.out(`${renderCheckText(env, { reportPath: result.snapshotPath })}\n`);
      for (const note of result.notes) rt.err(`${note}\n`);
    });
}
