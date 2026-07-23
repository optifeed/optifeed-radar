/**
 * The `shopping` command (M12a): SKU-level visibility for the products the
 * merchant NAMES. THIN over `runShopping` (the orchestrator) - it parses flags,
 * builds concrete deps, and renders the returned envelope. No pipeline logic
 * here (hard rule #1).
 *
 * There is no product discovery: `--products` / `--products-file` are the only
 * sources, and their order is the merchant's own ranking.
 */
import { Command } from 'commander';
import {
  ENGINE_ORDER,
  detectAvailableEngines,
  resolveStateDir,
} from '../core/config.js';
import { CostGuard } from '../core/costs.js';
import {
  renderShoppingHtml,
  renderShoppingJson,
  renderShoppingText,
  spendLine,
} from '../core/output/index.js';
import {
  MAX_PRODUCTS,
  ProductListError,
  nodeShoppingFs,
  parseProductsFlag,
} from '../core/shopping/index.js';
import {
  buildCheckDeps,
  runShopping,
  selectEngines,
  type ConfirmContext,
  type RunShoppingDeps,
} from '../core/run/index.js';
import type { EngineId } from '../core/types.js';
import { rejectStrayArgs } from './check.js';
import { createProgressReporter } from './progress.js';
import type { Runtime, ShoppingFlags } from './runtime.js';

function parseEngines(value: string): EngineId[] {
  const selection = selectEngines(value.split(','));
  return selection.kind === 'engines' ? selection.engines : [];
}

function toFlags(o: Record<string, unknown>): ShoppingFlags {
  return {
    yes: o.yes as boolean | undefined,
    json: o.json as boolean | undefined,
    report: o.report as string | undefined,
    products: o.products as string | undefined,
    productsFile: o.productsFile as string | undefined,
    engines: o.engines as EngineId[] | undefined,
    judge: o.judge as string | undefined,
    maxCost: o.maxCost as number | undefined,
    maxSetupCost: o.maxSetupCost as number | undefined,
    grounded: o.grounded as boolean | undefined,
    refresh: o.refresh as boolean | undefined,
    brand: o.brand as string | undefined,
    category: o.category as string | undefined,
  };
}

/**
 * Build the real shopping deps from env + flags. Shares `buildCheckDeps` with
 * `check`, so the judge-resolution dance exists in exactly one place, and adds
 * the shopping-run filesystem.
 */
export async function defaultShoppingDeps(
  rt: Runtime,
  flags: ShoppingFlags,
  available: EngineId[],
): Promise<RunShoppingDeps> {
  const guard = new CostGuard({
    maxCostUsd: flags.maxCost,
    maxSetupCostUsd: flags.maxSetupCost,
  });

  const { deps, judgeNotice, judgeQualityWarning } = await buildCheckDeps({
    env: rt.env,
    fetcher: rt.fetcher,
    engines: flags.engines,
    availableEngines: available,
    judgeModel: flags.judge,
    guard,
    now: () => rt.now(),
  });
  if (judgeNotice) rt.err(`${judgeNotice}\n`);
  if (judgeQualityWarning) rt.err(`${judgeQualityWarning}\n`);

  const confirm = async (ctx: ConfirmContext): Promise<boolean> => {
    const cost = ctx.estimate
      ? `about $${ctx.estimate.totalUsd.toFixed(4)}`
      : 'an unknown amount';
    // Prose to stderr so `--json` stdout stays a clean envelope. A shopping run
    // is bigger than a check, so the count of PRODUCTS leads: that is the
    // number the reader can act on before agreeing to spend.
    rt.err(
      `This will check ${ctx.nProducts ?? 0} products with ${ctx.nPrompts} prompts across ${ctx.engines.length} engines (estimated cost: ${cost}).\n`,
    );
    if (!rt.isTTY) {
      rt.err('Non-interactive: re-run with --yes to proceed.\n');
      return false;
    }
    const { confirm: ask } = await import('@inquirer/prompts');
    return ask({ message: 'Proceed?', default: false });
  };

  return {
    fetcher: deps.fetcher,
    adapters: deps.adapters,
    judge: deps.judge,
    guard: deps.guard,
    profileFs: deps.profileFs,
    shoppingFs: nodeShoppingFs(),
    now: deps.now,
    confirm,
  };
}

/** Register `shopping <domain>` on the program. */
export function registerShopping(program: Command, rt: Runtime): void {
  program
    .command('shopping')
    .argument('<domain>', 'the store site, e.g. example.com')
    .allowExcessArguments(true) // handled by rejectStrayArgs for a clean error
    .description(
      'Check whether AI engines recommend the products you name (beta)',
    )
    .option(
      '--products <list>',
      `comma-separated product names, best first (max ${MAX_PRODUCTS})`,
    )
    .option(
      '--products-file <file>',
      'YAML file of products (name, aliases, descriptor), best first',
    )
    .option('-y, --yes', 'skip the cost confirmation (for AI agents / CI)')
    .option('--json', 'output the raw JSON envelope (no ANSI)')
    .option('--report <file>', 'also write a self-contained HTML report')
    .option('--engines <list>', 'comma-separated engines to use', parseEngines)
    .option('--judge <model>', 'judge model for discovery/prompts/scoring')
    .option(
      '--max-cost <usd>',
      'cap total spend (checked before every call; overshoot is bounded by one unmeasured call per engine and always reported)',
      parseFloat,
    )
    .option(
      '--max-setup-cost <usd>',
      'cap discovery/prompt-writing spend (same bound as --max-cost)',
      parseFloat,
    )
    .option(
      '--grounded',
      'ask engines in grounded (web-search) mode where supported',
    )
    .option('--refresh', 'rediscover the store profile')
    .option('--brand <name>', 'set the brand name (skips discovery fetch)')
    .option('--category <name>', 'set the category (skips discovery fetch)')
    .action(async (domain: string, options, command: Command) => {
      if (
        rejectStrayArgs(
          rt,
          command,
          'Did you mean to pass it to a flag such as --products-file?',
        )
      ) {
        return;
      }

      const flags = toFlags(options as Record<string, unknown>);

      // One product source, explicitly chosen. A silent precedence rule would
      // quietly ignore half of what the user typed.
      if (flags.products && flags.productsFile) {
        rt.err(
          'Pass --products or --products-file, not both.\n' +
            'The order of that list is your own product ranking, so only one can define it.\n',
        );
        process.exitCode = 1;
        return;
      }
      if (!flags.products && !flags.productsFile) {
        rt.err(
          'shopping needs the products to check: pass --products "Aria 2, Presto X" ' +
            '(best first), or --products-file products.yml.\n' +
            'There is no product discovery yet, so the list is yours to name.\n',
        );
        process.exitCode = 1;
        return;
      }

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
          `shopping needs at least one engine API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY).\n` +
            `Export one in your shell, or put it in a .env file in this directory.\n` +
            (rt.envFile?.reason ? `${rt.envFile.reason}\n` : '') +
            `For a zero-key readiness check, run: audit ${domain}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const deps = rt.shoppingDeps
        ? rt.shoppingDeps(flags)
        : await defaultShoppingDeps(rt, flags, available);

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
        result = await runShopping(domain, deps, {
          stateDir,
          ...(flags.products
            ? { products: parseProductsFlag(flags.products) }
            : {}),
          ...(flags.productsFile ? { productsFile: flags.productsFile } : {}),
          yes: flags.yes,
          mode: flags.grounded ? 'grounded' : undefined,
          refresh: flags.refresh,
          brand: flags.brand,
          category: flags.category,
        });
      } catch (e) {
        // An unusable product list is a usage error, not a crash: say what is
        // wrong with the list rather than printing a stack trace.
        if (e instanceof ProductListError) {
          rt.err(`${e.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw e;
      } finally {
        reporter?.stop();
      }

      if (result.aborted) {
        const say = (s: string): void => {
          if (flags.json) rt.err(s);
          else rt.out(s);
        };
        say('Aborted - no engines were queried.\n');
        // Discovery and prompt writing bill BEFORE the gate, so an aborted run
        // is not necessarily a free one.
        const spent = result.spend;
        if (spent && spent.totalUsd > 0) say(`${spendLine(spent)}\n`);
        return;
      }
      const env = result.envelope!;

      let reportWritten: string | undefined;
      if (flags.report) {
        try {
          await rt.writeFile(flags.report, renderShoppingHtml(env));
          reportWritten = flags.report;
        } catch (e) {
          rt.err(
            `Could not write report to ${flags.report}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }

      if (flags.json) {
        rt.out(`${renderShoppingJson(env)}\n`);
        if (reportWritten) rt.err(`HTML report written to ${reportWritten}\n`);
      } else {
        rt.out(
          `${renderShoppingText(env, { reportPath: result.savedPath })}\n`,
        );
        if (reportWritten) rt.out(`HTML report written to ${reportWritten}\n`);
      }
      for (const note of result.notes) rt.err(`${note}\n`);
    });
}
