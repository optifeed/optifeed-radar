/**
 * Shared, entrypoint-agnostic construction of the concrete `runCheck`
 * dependencies (engine adapters, judge client, node fs). Both the CLI (M11)
 * and the MCP server (M15) consume this so the fiddly judge-resolution dance
 * lives in exactly one place. It lives in `core/` so `mcp/` never has to
 * import `cli/` (hard rule #1).
 *
 * It returns everything EXCEPT `confirm` and `onProgress` - the two
 * entrypoint-specific pieces (a TTY prompt vs. non-interactive; a spinner vs.
 * MCP progress notifications). The caller attaches those.
 */
import { CostGuard } from '../costs.js';
import { ENGINE_ORDER, engineForModel, resolveJudgeModel } from '../config.js';
import { createEngineAdapters, createJudgeClient } from '../engines/index.js';
import { nodeProfileFs } from '../discovery/index.js';
import { nodeQueryFs } from '../queries/index.js';
import { nodeSnapshotFs } from '../output/index.js';
import type { Fetcher } from '../fetcher/index.js';
import type { EngineId } from '../types.js';
import type { RunCheckDeps } from './check.js';

export interface BuildCheckDepsInput {
  env: Record<string, string | undefined>;
  fetcher: Fetcher;
  engines?: EngineId[];
  availableEngines: EngineId[];
  judgeModel?: string;
  guard?: CostGuard;
  now?: () => string;
}

export interface BuiltCheckDeps {
  deps: Omit<RunCheckDeps, 'confirm' | 'onProgress'>;
  judgeNotice?: string;
  /**
   * Set when the resolved judge has a MEASURED quality problem. Entrypoints
   * must surface it: it warns that this run's competitor list may be invented
   * (rule #6). Kept separate from {@link judgeNotice}, which only explains
   * which judge was picked and is silent on quality.
   */
  judgeQualityWarning?: string;
}

export async function buildCheckDeps(
  input: BuildCheckDepsInput,
): Promise<BuiltCheckDeps> {
  // Own miss path (no non-null assertion downstream): the judge falls back to
  // the first available engine, so an empty set has no judge. Fail honestly
  // here rather than building a judge over an undefined adapter that would
  // crash on first use if a caller forgets the upstream guard.
  if (input.availableEngines.length === 0) {
    throw new Error(
      'buildCheckDeps needs at least one available engine (an API key must be set).',
    );
  }

  const wanted = input.engines?.length ? input.engines : ENGINE_ORDER;
  const adapters = createEngineAdapters({ env: input.env }).filter((a) =>
    wanted.includes(a.id),
  );

  const judgeRes = await resolveJudgeModel({
    interactive: false,
    availableEngines: input.availableEngines,
    savedJudgeModel: input.judgeModel,
  });
  // Route by the model id's own provider, never by "first available engine":
  // that fallback silently built an adapter for the WRONG provider whenever a
  // judge default changed, and then every judge call 400s with a cross-provider
  // error that tells the user nothing.
  const judgeEngine = engineForModel(judgeRes.model);
  if (!judgeEngine) {
    throw new Error(
      `Cannot tell which provider serves judge model "${judgeRes.model}". ` +
        `Pass a model from a supported provider with --judge.`,
    );
  }
  // Build ONLY the judge engine's adapter (with its resolved model), not all
  // four again. The ask `adapters` above keep their default models; the judge
  // may use a different (cheaper) model, so it needs its own instance.
  const judgeAdapter = createEngineAdapters({
    env: input.env,
    models: { [judgeEngine]: judgeRes.model },
    only: [judgeEngine],
  })[0]!;

  return {
    deps: {
      fetcher: input.fetcher,
      adapters,
      judge: createJudgeClient(judgeAdapter),
      guard: input.guard ?? new CostGuard(),
      profileFs: nodeProfileFs(),
      queryFs: nodeQueryFs(),
      snapshotFs: nodeSnapshotFs(),
      now: input.now ?? ((): string => new Date().toISOString()),
    },
    judgeNotice: judgeRes.notice,
    judgeQualityWarning: judgeRes.qualityWarning,
  };
}
