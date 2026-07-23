/**
 * Non-interactive dependency construction for the MCP server. Thin over the
 * shared `core/run` `buildCheckDeps` factory (so `mcp/` never imports `cli/` -
 * hard rule #1); adds MCP-specific policy: a default cost cap and no confirm
 * gate (tools pass `yes: true`).
 */
import {
  buildCheckDeps,
  type RunCheckDeps,
  type RunGenerateQueriesDeps,
  type RunShoppingDeps,
} from '../core/run/index.js';
import { CostGuard } from '../core/costs.js';
import { detectAvailableEngines, resolveStateDir } from '../core/config.js';
import { nodeSnapshotFs, type SnapshotFs } from '../core/output/index.js';
import { nodeShoppingFs } from '../core/shopping/index.js';
import { createFetcher, type Fetcher } from '../core/fetcher/index.js';
import type { EngineId } from '../core/types.js';

/** Default hard cap on a single check_visibility run (agent may override). */
export const DEFAULT_MCP_MAX_COST = 0.5;

/**
 * Default cap PER PRODUCT for shopping_check (agent may override with max_cost).
 *
 * A shopping run is much larger than a check - up to 10 products x 4 prompts x
 * every keyed engine - so the flat $0.50 would truncate most multi-product runs
 * into a partial ranking. Scaling with the list keeps a 2-product call cheap
 * while letting a 10-product call finish and mean something.
 */
export const DEFAULT_MCP_SHOPPING_PER_PRODUCT_USD = 0.2;

export interface ToolContext {
  /** State dir (snapshots/profile/queries) for a domain. */
  resolveStateDir(domain: string): string;
  /** Full check deps for runCheck; `maxCost` overrides the default cap. */
  checkDeps(opts: {
    engines?: EngineId[];
    maxCost?: number;
    availableEngines: EngineId[];
  }): Promise<RunCheckDeps>;
  /** Deps for runGenerateQueries (async: resolves the judge once). */
  queryDeps(): Promise<RunGenerateQueriesDeps>;
  /**
   * Deps for runShopping (M12a). `productCount` sizes the default cap; an
   * explicit `maxCost` from the agent always wins.
   */
  shoppingDeps(opts: {
    productCount: number;
    engines?: EngineId[];
    maxCost?: number;
    availableEngines: EngineId[];
  }): Promise<RunShoppingDeps>;
  /**
   * A FRESH fetcher for one tool invocation. The default fetcher's cache is a
   * permanent per-instance Map (built for a single CLI run), so a fetcher must
   * never be shared across calls in a long-lived MCP session - that would serve
   * stale responses and grow unbounded. Each tool call gets its own.
   */
  newFetcher(): Fetcher;
  /** Snapshot fs for get_snapshot_diff. */
  snapshotFs: SnapshotFs;
  /** Engines that have keys in this environment. */
  availableEngines(): EngineId[];
  /** ISO clock. */
  now(): string;
  /** Stderr log for judge notices (NEVER stdout - it is the MCP stream). */
  log(msg: string): void;
}

export interface DefaultToolContextInput {
  env: Record<string, string | undefined>;
  cwd: string;
  homeDir: string;
  isProjectWritable: boolean;
  fetcher?: Fetcher;
  now?: () => string;
  /** Where notices go; defaults to process.stderr (never stdout). */
  log?: (msg: string) => void;
}

export function defaultToolContext(
  input: DefaultToolContextInput,
): ToolContext {
  // A fresh fetcher per call (or the injected one, so tests can observe it).
  const newFetcher = (): Fetcher => input.fetcher ?? createFetcher();
  const now = input.now ?? ((): string => new Date().toISOString());
  const log =
    input.log ?? ((msg: string): void => void process.stderr.write(`${msg}\n`));

  const available = (): EngineId[] => detectAvailableEngines(input.env);

  return {
    resolveStateDir: (domain: string): string =>
      resolveStateDir({
        cwd: input.cwd,
        homeDir: input.homeDir,
        domain,
        isProjectWritable: input.isProjectWritable,
      }),

    checkDeps: async (opts): Promise<RunCheckDeps> => {
      const guard = new CostGuard({
        maxCostUsd: opts.maxCost ?? DEFAULT_MCP_MAX_COST,
      });
      const { deps, judgeNotice, judgeQualityWarning } = await buildCheckDeps({
        env: input.env,
        fetcher: newFetcher(),
        engines: opts.engines,
        availableEngines: opts.availableEngines,
        guard,
        now,
      });
      if (judgeNotice) log(judgeNotice);
      if (judgeQualityWarning) log(judgeQualityWarning);
      // No confirm gate: MCP tools pass `yes: true` (hard rule #8).
      return deps;
    },

    shoppingDeps: async (opts): Promise<RunShoppingDeps> => {
      const guard = new CostGuard({
        maxCostUsd:
          opts.maxCost ??
          // At least one product's worth of budget, so a zero-length list can
          // never produce a $0 cap that refuses every call.
          Math.max(1, opts.productCount) * DEFAULT_MCP_SHOPPING_PER_PRODUCT_USD,
      });
      const { deps, judgeNotice, judgeQualityWarning } = await buildCheckDeps({
        env: input.env,
        fetcher: newFetcher(),
        engines: opts.engines,
        availableEngines: opts.availableEngines,
        guard,
        now,
      });
      if (judgeNotice) log(judgeNotice);
      if (judgeQualityWarning) log(judgeQualityWarning);
      // No confirm gate: MCP tools pass `yes: true` (hard rule #8).
      return {
        fetcher: deps.fetcher,
        adapters: deps.adapters,
        judge: deps.judge,
        guard: deps.guard,
        profileFs: deps.profileFs,
        shoppingFs: nodeShoppingFs(),
        now: deps.now,
      };
    },

    queryDeps: async (): Promise<RunGenerateQueriesDeps> => {
      // Reuse buildCheckDeps for ONE judge-resolution path; runGenerateQueries
      // only needs the judge + fetcher + guard + clock from it.
      const guard = new CostGuard({ maxSetupCostUsd: DEFAULT_MCP_MAX_COST });
      const fetcher = newFetcher();
      const { deps, judgeNotice, judgeQualityWarning } = await buildCheckDeps({
        env: input.env,
        fetcher,
        availableEngines: available(),
        guard,
        now,
      });
      if (judgeNotice) log(judgeNotice);
      if (judgeQualityWarning) log(judgeQualityWarning);
      return { fetcher, judge: deps.judge, guard, now };
    },

    newFetcher,
    snapshotFs: nodeSnapshotFs(),
    availableEngines: available,
    now,
    log,
  };
}
