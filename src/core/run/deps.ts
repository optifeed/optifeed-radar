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
import {
  DEFAULT_JUDGE_MODELS,
  ENGINE_ORDER,
  resolveJudgeModel,
} from '../config.js';
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
  const judgeEngine =
    ENGINE_ORDER.find((e) => DEFAULT_JUDGE_MODELS[e] === judgeRes.model) ??
    input.availableEngines[0]!;
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
  };
}
