/**
 * The `check` orchestrator (M10) - THE SEAM every entrypoint adapts over.
 *
 * One function wires the whole pipeline so no orchestration logic ever lives in
 * `cli/` or `mcp/` (hard rule #1): discover the brand (M4), resolve the buyer
 * prompts (M5), estimate + confirm the main spend, ask the engines (M6), score
 * the answers (M7), fold in the audit findings (M3), assemble the M8 envelope,
 * and write a snapshot. It renders nothing - callers render via M9.
 *
 * Everything that spends or touches the network is injected (fetcher, engine
 * adapters, judge, cost guard, fs, clock), so tests drive the entire flow with
 * mocks and no network (hard rule #3). The cost guard's two-phase budget is
 * honored end to end (discovery/query-gen on `setup`, asking/judging on `main`)
 * and the run's honesty - `costCapped`, `skippedEngines`, `degraded` - is
 * assembled from all three independent signals and surfaced upward, never
 * hidden (hard rule #6).
 */
import { CostGuard, type CostEstimate, estimateRun } from '../costs.js';
import { type ProfileFs, discover, nodeProfileFs } from '../discovery/index.js';
import { type AskMode, type EngineAdapter, askAll } from '../engines/index.js';
import type { Fetcher } from '../fetcher/index.js';
import { buildAuditReport, gatherAuditInput } from '../audit/index.js';
import { type QueryFs, nodeQueryFs, resolveQueries } from '../queries/index.js';
import { scoreAnswers } from '../scoring/index.js';
import {
  type SnapshotFs,
  type VisibilityEnvelope,
  buildEnvelope,
  nodeSnapshotFs,
  saveSnapshot,
} from '../output/index.js';
import { createFetcher } from '../fetcher/index.js';
import { createEngineAdapters } from '../engines/index.js';
import type { EngineId, JudgeClient, RunHonesty } from '../types.js';

/** Context passed to the confirmation gate before the main ASK spend. */
export interface ConfirmContext {
  /** Pre-run cost estimate, or undefined if it could not be priced. */
  estimate?: CostEstimate;
  /** Number of buyer prompts that will be asked to each engine. */
  nPrompts: number;
  /** Engines that will be asked (available ones). */
  engines: EngineId[];
}

/** Injected collaborators. Anything that spends or hits the network lives here. */
export interface RunCheckDeps {
  /** Fetcher (M2); defaults to a real-network fetcher. */
  fetcher?: Fetcher;
  /** Engine adapters (M6); their availability drives `skippedEngines`. Defaults from env. */
  adapters?: EngineAdapter[];
  /** Judge for discovery/query-gen/scoring pass 2. */
  judge?: JudgeClient;
  /** Two-phase cost guard; defaults to uncapped. */
  guard?: CostGuard;
  /** Profile persistence (M4). */
  profileFs?: ProfileFs;
  /** Query pack persistence (M5). */
  queryFs?: QueryFs;
  /** Snapshot persistence (M8). */
  snapshotFs?: SnapshotFs;
  /** Clock, injected for deterministic `generatedAt`. */
  now?: () => string;
  /**
   * Confirmation gate before the main spend. Return false to abort without
   * asking any engine. Skipped entirely when `opts.yes` is set (hard rule #8).
   */
  confirm?: (ctx: ConfirmContext) => Promise<boolean>;
  /** Env for the default adapter set, when `adapters` is not injected. */
  env?: Record<string, string | undefined>;
}

/** Options mirroring the `check` command's flags. */
export interface RunCheckOptions {
  /** State dir for profile/queries/snapshots (from `resolveStateDir`). */
  stateDir: string;
  // discovery
  refresh?: boolean;
  brand?: string;
  category?: string;
  samplePages?: number;
  // queries
  regenerate?: boolean;
  queriesFile?: string;
  count?: number;
  // engines / scoring
  mode?: AskMode;
  concurrency?: number;
  judgeRateCap?: number;
  // control
  /** Skip the confirmation gate (agents / CI). */
  yes?: boolean;
  /** Persist profile, queries, and the snapshot (default true). */
  persist?: boolean;
}

/** Outcome of {@link runCheck}. */
export interface RunCheckResult {
  /** The check envelope; absent only when the run was aborted at confirmation. */
  envelope?: VisibilityEnvelope;
  /** True when the confirmation gate declined the spend (no engines asked). */
  aborted: boolean;
  /** Snapshot path written, if persisted this run. */
  snapshotPath?: string;
  /** Human-readable notes (competitor skip, query-gen skip, confirmation abort). */
  notes: string[];
}

/**
 * Run the full `check` pipeline for `domain`. Never throws for a partial run -
 * a cost cap, a skipped engine, or a degraded profile come back on the envelope.
 */
export async function runCheck(
  domain: string,
  deps: RunCheckDeps = {},
  opts: RunCheckOptions,
): Promise<RunCheckResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const fetcher = deps.fetcher ?? createFetcher();
  const guard = deps.guard ?? new CostGuard();
  const adapters =
    deps.adapters ?? createEngineAdapters({ env: deps.env ?? process.env });
  const persist = opts.persist ?? true;
  const notes: string[] = [];

  // Discovery (M4) and the zero-LLM audit (M3) are independent fetch-only work;
  // run them concurrently (the fetcher's in-run cache dedupes shared URLs).
  const [discovery, auditReport] = await Promise.all([
    discover(
      domain,
      {
        fetcher,
        judge: deps.judge,
        guard,
        fs: deps.profileFs ?? nodeProfileFs(),
        now,
      },
      {
        stateDir: opts.stateDir,
        refresh: opts.refresh,
        brand: opts.brand,
        category: opts.category,
        samplePages: opts.samplePages,
        persist,
      },
    ),
    gatherAuditInput(domain, fetcher, { samplePages: opts.samplePages }).then(
      buildAuditReport,
    ),
  ]);
  const profile = discovery.profile;
  if (discovery.competitorNote) notes.push(discovery.competitorNote);

  // Query pack (M5): explicit file > cached > generate (setup budget).
  const queries = await resolveQueries(
    profile,
    { judge: deps.judge, guard, fs: deps.queryFs ?? nodeQueryFs(), now },
    {
      stateDir: opts.stateDir,
      regenerate: opts.regenerate,
      queriesFile: opts.queriesFile,
      count: opts.count,
      persist,
    },
  );
  if (queries.note) notes.push(queries.note);
  const prompts = queries.pack.queries.map((q) => q.prompt);

  // Estimate the main ASK and gate on it (bypassable with --yes, hard rule #8).
  const availableEngines = adapters.filter((a) => a.available());
  const estimate = priceRun(prompts.length, availableEngines, deps.judge);
  if (!opts.yes && deps.confirm) {
    const ok = await deps.confirm({
      estimate,
      nPrompts: prompts.length,
      engines: availableEngines.map((a) => a.id),
    });
    if (!ok) {
      notes.push('Run aborted at the cost confirmation.');
      return { aborted: true, notes };
    }
  }

  // Ask (M6): a total engine failure never kills the run; the cost cap trips
  // here on the main budget and returns partial answers, never over-spending.
  const asked = await askAll(prompts, adapters, {
    mode: opts.mode,
    guard,
    concurrency: opts.concurrency,
  });

  // Score (M7): deterministic pass 1 + a budgeted judge pass 2.
  const generatedAt = now();
  const score = await scoreAnswers(
    asked.answers,
    profile,
    { judge: deps.judge, guard },
    { judgeRateCap: opts.judgeRateCap, generatedAt },
  );

  // Assemble honesty from ALL three independent signals (M8 review lesson #1):
  // a cap, a skipped engine, or a degraded profile each make the run partial.
  const honesty: RunHonesty = {
    costCapped: guard.costCapped ? true : undefined,
    skippedEngines:
      asked.skippedEngines.length > 0 ? asked.skippedEngines : undefined,
    degraded: profile.degraded ? true : undefined,
  };

  const envelope = buildEnvelope({
    profile,
    score,
    answers: asked.answers,
    auditFindings: auditReport.findings,
    honesty,
    generatedAt,
  });

  let snapshotPath: string | undefined;
  if (persist) {
    snapshotPath = await saveSnapshot(
      envelope,
      opts.stateDir,
      deps.snapshotFs ?? nodeSnapshotFs(),
    );
  }

  return { envelope, aborted: false, snapshotPath, notes };
}

/** Best-effort cost estimate; undefined when no judge or an unpriced model. */
function priceRun(
  nPrompts: number,
  availableEngines: EngineAdapter[],
  judge?: JudgeClient,
): CostEstimate | undefined {
  if (!judge || nPrompts === 0 || availableEngines.length === 0) {
    return undefined;
  }
  try {
    return estimateRun(
      nPrompts,
      availableEngines.map((a) => a.model),
      judge.model,
    );
  } catch {
    // An unpriced model must not block the run; the guard still caps spend.
    return undefined;
  }
}
