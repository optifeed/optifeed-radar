/**
 * The scoring orchestrator (M7): engine answers -> the AI Visibility Score.
 *
 * Pass 1 (deterministic) analyzes every answer; the judge pass (optional, ≤30%
 * of answers, cost-guarded) refines only the ambiguous ones; then per-engine
 * and composite scores, share of voice, and sources are aggregated into a
 * {@link ScoreReport}. All judge I/O is injected.
 */
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type EngineScore,
  type JudgeClient,
  type MentionResult,
  type ScoreReport,
} from '../types.js';
import { analyzeAnswer } from './detect.js';
import { JUDGE_RATE_CAP, refineAmbiguous } from './judge.js';
import {
  aggregateSources,
  compositeScore,
  scoreEngine,
  shareOfVoice,
} from './score.js';

export interface ScoreDeps {
  /** Judge for pass 2; omit to skip it (ambiguous results stay as pass 1). */
  judge?: JudgeClient;
  guard?: CostGuard;
}

export interface ScoreOptions {
  /** Max share of answers judged in pass 2 (default {@link JUDGE_RATE_CAP}). */
  judgeRateCap?: number;
  generatedAt?: string;
}

/** Score a run's engine answers against the brand profile. */
export async function scoreAnswers(
  answers: EngineAnswer[],
  profile: BrandProfile,
  deps: ScoreDeps,
  opts: ScoreOptions = {},
): Promise<ScoreReport> {
  const cap = opts.judgeRateCap ?? JUDGE_RATE_CAP;

  // Pass 1: deterministic analysis of every answer (aligned 1:1 with answers).
  let results = answers.map((a) => analyzeAnswer(a, profile));

  // Pass 2: judge only the ambiguous ones, within the rate + cost budgets.
  let judged = 0;
  if (deps.judge) {
    const refined = await refineAmbiguous(
      results,
      answers,
      profile,
      { judge: deps.judge, guard: deps.guard ?? new CostGuard() },
      { judgeRateCap: cap },
    );
    results = refined.results;
    judged = refined.judged;
  }

  // Per-engine aggregation (kind taken from the engine's own answers).
  const engines = scorePerEngine(answers, results);
  const score = compositeScore(engines);

  return {
    schema_version: SCHEMA_VERSION,
    domain: profile.domain,
    score,
    engines,
    mentions: results,
    shareOfVoice: shareOfVoice(results, profile),
    sources: aggregateSources(results),
    sampling: { answers: results.length, judged, judgeRateCap: cap },
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
  };
}

/** Group results by engine (in first-seen order) and score each. */
function scorePerEngine(
  answers: EngineAnswer[],
  results: MentionResult[],
): EngineScore[] {
  const order: EngineId[] = [];
  const grouped = new Map<EngineId, MentionResult[]>();
  const kinds = new Map<EngineId, EngineKind>();

  answers.forEach((answer, i) => {
    const result = results[i];
    if (!result) return;
    if (!grouped.has(answer.engine)) {
      grouped.set(answer.engine, []);
      order.push(answer.engine);
    }
    grouped.get(answer.engine)?.push(result);
    // A grounded answer marks the engine grounded for weighting.
    if (answer.kind === 'grounded' || !kinds.has(answer.engine)) {
      kinds.set(answer.engine, answer.kind);
    }
  });

  return order.map((engine) =>
    scoreEngine(
      engine,
      kinds.get(engine) ?? 'parametric',
      grouped.get(engine) ?? [],
    ),
  );
}
