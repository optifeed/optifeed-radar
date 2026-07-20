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
import {
  CostGuard,
  type CostEstimate,
  ESTIMATE_ASSUMPTIONS,
  estimateRun,
} from '../costs.js';
import type { ProfileFs } from '../discovery/index.js';
import { type AskMode, type EngineAdapter, askAll } from '../engines/index.js';
import type { Fetcher } from '../fetcher/index.js';
import { buildAuditReport, gatherAuditInput } from '../audit/index.js';
import type { QueryFs } from '../queries/index.js';
import { scoreAnswers } from '../scoring/index.js';
import { discoverAndBuildQueries } from './discover-queries.js';
import {
  type SnapshotFs,
  type VisibilityEnvelope,
  buildEnvelope,
  nodeSnapshotFs,
  saveSnapshot,
} from '../output/index.js';
import { createFetcher } from '../fetcher/index.js';
import { createEngineAdapters } from '../engines/index.js';
import type { EngineId, JudgeClient, RunHonesty, RunSpend } from '../types.js';

/**
 * Progress events emitted through a run's phases. Structured data only - the
 * orchestrator never renders (hard rule #1); a caller (the CLI) turns these
 * into a spinner and per-prompt lines.
 */
export type ProgressEvent =
  | { kind: 'discovery-start' }
  | { kind: 'discovery-done'; brand: string }
  | { kind: 'queries-start' }
  | { kind: 'queries-done'; prompts: string[] }
  | { kind: 'ask-start'; total: number }
  | { kind: 'ask-answered'; done: number; total: number }
  | { kind: 'ask-done'; answered: number; total: number }
  | { kind: 'scoring-start' }
  | { kind: 'scoring-done' };

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
  /** Progress sink for interactive rendering; defaults to a no-op. */
  onProgress?: (event: ProgressEvent) => void;
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
  /**
   * What the run spent, from the cost guard.
   *
   * Present even on an ABORTED run: discovery and query generation happen
   * before the confirmation gate, so declining still billed for the setup
   * phase. Reporting only on success would tell a user who declined in order
   * to avoid spending that the run was free.
   */
  spend?: RunSpend;
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
  const report = deps.onProgress ?? ((): void => undefined);
  const notes: string[] = [];

  // The shared front half - discover the brand (M4) then resolve the buyer
  // prompts (M5) - runs concurrently with the zero-LLM audit (M3), which is
  // independent fetch-only work (the fetcher's in-run cache dedupes shared
  // URLs). The helper emits the discovery/queries progress events itself.
  report({ kind: 'discovery-start' });
  const [front, auditReport] = await Promise.all([
    discoverAndBuildQueries(
      domain,
      {
        fetcher,
        judge: deps.judge,
        guard,
        profileFs: deps.profileFs,
        queryFs: deps.queryFs,
        now,
      },
      {
        stateDir: opts.stateDir,
        persist,
        refresh: opts.refresh,
        brand: opts.brand,
        category: opts.category,
        samplePages: opts.samplePages,
        regenerate: opts.regenerate,
        queriesFile: opts.queriesFile,
        count: opts.count,
      },
      report,
    ),
    gatherAuditInput(domain, fetcher, { samplePages: opts.samplePages }).then(
      buildAuditReport,
    ),
  ]);
  const profile = front.profile;
  notes.push(...front.notes);
  const prompts = front.pack.queries.map((q) => q.prompt);
  // Branded prompts (M5's "trust" intent) named the brand; scoring keeps them
  // out of the visibility score and reports them as reputation instead.
  const brandedPrompts = front.pack.queries
    .filter((q) => q.intent === 'trust')
    .map((q) => q.prompt);

  // Gate the main ASK spend (bypassable with --yes, hard rule #8). Spending is
  // allowed ONLY when explicitly confirmed: `--yes`, or a `confirm` handler that
  // returns true. A consumer that wires neither (e.g. a misconfigured MCP call)
  // must NOT silently spend - the safe default is to abort before asking.
  const availableEngines = adapters.filter((a) => a.available());
  if (!opts.yes) {
    if (!deps.confirm) {
      notes.push(
        'Aborted before spending: engine queries need confirmation. Pass yes to run non-interactively, or provide a confirm handler.',
      );
      return { aborted: true, notes, spend: guard.spendBreakdown };
    }
    const estimate = priceRun(
      prompts.length,
      availableEngines,
      deps.judge,
      opts.mode === 'grounded',
    );
    const ok = await deps.confirm({
      estimate,
      nPrompts: prompts.length,
      engines: availableEngines.map((a) => a.id),
    });
    if (!ok) {
      notes.push('Run aborted at the cost confirmation.');
      return { aborted: true, notes, spend: guard.spendBreakdown };
    }
  }

  // Ask (M6): a total engine failure never kills the run; the cost cap trips
  // here on the main budget and returns partial answers, never over-spending.
  const total = prompts.length * availableEngines.length;
  report({ kind: 'ask-start', total });
  let done = 0;
  const asked = await askAll(prompts, adapters, {
    mode: opts.mode,
    guard,
    concurrency: opts.concurrency,
    onAnswered: () => {
      done += 1;
      report({ kind: 'ask-answered', done, total });
    },
  });
  report({ kind: 'ask-done', answered: asked.answers.length, total });

  // Score (M7): deterministic pass 1 + a budgeted judge pass 2.
  report({ kind: 'scoring-start' });
  const generatedAt = now();
  const score = await scoreAnswers(
    asked.answers,
    profile,
    { judge: deps.judge, guard },
    { judgeRateCap: opts.judgeRateCap, generatedAt, brandedPrompts },
  );
  report({ kind: 'scoring-done' });

  // Assemble honesty from ALL FOUR independent signals (M8 review lesson #1):
  // a cap, a skipped engine, an engine that answered only some prompts, or a
  // degraded profile each make the run partial. Dropping any one of them
  // relaunders a partial run as complete.
  const honesty: RunHonesty = {
    costCapped: guard.costCapped ? true : undefined,
    skippedEngines:
      asked.skippedEngines.length > 0 ? asked.skippedEngines : undefined,
    partialEngines:
      asked.partialEngines.length > 0 ? asked.partialEngines : undefined,
    degraded: profile.degraded ? true : undefined,
  };

  const envelope = buildEnvelope({
    profile,
    score,
    answers: asked.answers,
    auditFindings: auditReport.findings,
    honesty,
    // Read from the guard, not by summing answers: discovery, query generation
    // and the scoring judge all spend without producing an answer to sum.
    // Taken AFTER scoring so the judge pass is included.
    // Always attached for a run that had a guard - a recorded zero is data, and
    // the RENDERERS decide whether a zero is worth stating (it is ambiguous
    // between "free" and "could not be priced", so they stay silent).
    spend: guard.spendBreakdown,
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

  // Spend rides the success return too, not just the abort paths: a consumer
  // branching on `result.spend` would otherwise see it defined only for runs
  // that spent almost nothing, and undefined for the run that actually spent.
  return {
    envelope,
    aborted: false,
    snapshotPath,
    notes,
    spend: guard.spendBreakdown,
  };
}

/** Best-effort cost estimate; undefined when no judge or an unpriced model. */
function priceRun(
  nPrompts: number,
  availableEngines: EngineAdapter[],
  judge?: JudgeClient,
  grounded = false,
): CostEstimate | undefined {
  if (!judge || nPrompts === 0 || availableEngines.length === 0) {
    return undefined;
  }
  try {
    return estimateRun(
      nPrompts,
      availableEngines.map((a) => a.model),
      judge.model,
      // A grounded run owes a per-search fee that can exceed its token cost,
      // so the confirm gate must quote the run being requested, not a
      // parametric one.
      { ...ESTIMATE_ASSUMPTIONS, grounded },
    );
  } catch {
    // An unpriced model must not block the run; the guard still caps spend.
    return undefined;
  }
}
