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
} from '../core/run/index.js';
import { CostGuard } from '../core/costs.js';
import { detectAvailableEngines, resolveStateDir } from '../core/config.js';
import { nodeSnapshotFs, type SnapshotFs } from '../core/output/index.js';
import { createFetcher, type Fetcher } from '../core/fetcher/index.js';
import type { EngineId } from '../core/types.js';

/** Default hard cap on a single check_visibility run (agent may override). */
export const DEFAULT_MCP_MAX_COST = 0.5;

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
  /** Fetcher for the zero-key audit. */
  fetcher: Fetcher;
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
  const fetcher = input.fetcher ?? createFetcher();
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
      const { deps, judgeNotice } = await buildCheckDeps({
        env: input.env,
        fetcher,
        engines: opts.engines,
        availableEngines: opts.availableEngines,
        guard,
        now,
      });
      if (judgeNotice) log(judgeNotice);
      // No confirm gate: MCP tools pass `yes: true` (hard rule #8).
      return deps;
    },

    queryDeps: async (): Promise<RunGenerateQueriesDeps> => {
      // Reuse buildCheckDeps for ONE judge-resolution path; runGenerateQueries
      // only needs the judge + fetcher + guard + clock from it.
      const guard = new CostGuard({ maxSetupCostUsd: DEFAULT_MCP_MAX_COST });
      const { deps, judgeNotice } = await buildCheckDeps({
        env: input.env,
        fetcher,
        availableEngines: available(),
        guard,
        now,
      });
      if (judgeNotice) log(judgeNotice);
      return { fetcher, judge: deps.judge, guard, now };
    },

    fetcher,
    snapshotFs: nodeSnapshotFs(),
    availableEngines: available,
    now,
    log,
  };
}
