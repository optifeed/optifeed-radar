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
  type Reputation,
  type ScoreReport,
} from '../types.js';
import { analyzeAnswer } from './detect.js';
import { answerRetrieved } from './retrieval.js';
import { JUDGE_RATE_CAP, refineAmbiguous } from './judge.js';
import {
  aggregateSources,
  compositeScore,
  scoreEngine,
  shareOfVoice,
  SCORING_VERSION,
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
  /**
   * Prompts that named the brand (M5's "trust" intent). Their answers are kept
   * OUT of the visibility score - naming the brand guarantees a mention - and
   * summarized separately as {@link Reputation}. Empty/omitted = score every
   * answer as before.
   */
  brandedPrompts?: string[];
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
  if (deps.judge) {
    const refined = await refineAmbiguous(
      results,
      answers,
      profile,
      { judge: deps.judge, guard: deps.guard ?? new CostGuard() },
      { judgeRateCap: cap },
    );
    results = refined.results;
  }

  // Partition answers by whether their prompt named the brand. Branded prompts
  // are scored apart (reputation), never folded into the visibility score.
  const branded = new Set(opts.brandedPrompts ?? []);
  const discovery: { answer: EngineAnswer; result: MentionResult }[] = [];
  const reputationResults: MentionResult[] = [];
  answers.forEach((answer, i) => {
    const result = results[i];
    if (!result) return;
    if (branded.has(answer.prompt)) reputationResults.push(result);
    else discovery.push({ answer, result });
  });

  // The score, per-engine aggregation, share of voice, and sources all read the
  // DISCOVERY answers only (the honest "surfaced unprompted" signal).
  const discoveryAnswers = discovery.map((d) => d.answer);
  const discoveryResults = discovery.map((d) => d.result);
  const engines = scorePerEngine(discoveryAnswers, discoveryResults);
  const score = compositeScore(engines);
  const judged = discoveryResults.filter((r) => r.judged).length;

  return {
    schema_version: SCHEMA_VERSION,
    domain: profile.domain,
    score,
    scoringVersion: SCORING_VERSION,
    engines,
    mentions: discoveryResults,
    shareOfVoice: shareOfVoice(discoveryResults, profile),
    sources: aggregateSources(discoveryResults),
    ...(reputationResults.length > 0
      ? { reputation: summarizeReputation(answers, branded, reputationResults) }
      : {}),
    sampling: { answers: discoveryResults.length, judged, judgeRateCap: cap },
    ...(opts.generatedAt ? { generatedAt: opts.generatedAt } : {}),
  };
}

/** Count sentiment across branded answers into a {@link Reputation} block. */
function summarizeReputation(
  answers: EngineAnswer[],
  branded: Set<string>,
  results: MentionResult[],
): Reputation {
  const prompts = new Set(
    answers.filter((a) => branded.has(a.prompt)).map((a) => a.prompt),
  ).size;
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  for (const r of results) {
    if (r.sentiment === 'positive') positive++;
    else if (r.sentiment === 'negative') negative++;
    else neutral++;
  }
  return { prompts, answers: results.length, positive, neutral, negative };
}

/** Group results by engine (in first-seen order) and score each. */
function scorePerEngine(
  answers: EngineAnswer[],
  results: MentionResult[],
): EngineScore[] {
  const order: EngineId[] = [];
  const grouped = new Map<EngineId, MentionResult[]>();
  const kinds = new Map<EngineId, EngineKind>();

  // How many of each engine's answers actually retrieved. Grounded mode is a
  // request the model can decline, so this - not `kind` - decides how much of
  // the grounded premium the engine earns (see `effectiveWeight`).
  const retrieved = new Map<EngineId, number>();

  answers.forEach((answer, i) => {
    const result = results[i];
    if (!result) return;
    if (!grouped.has(answer.engine)) {
      grouped.set(answer.engine, []);
      order.push(answer.engine);
    }
    grouped.get(answer.engine)?.push(result);
    if (answerRetrieved(answer)) {
      retrieved.set(answer.engine, (retrieved.get(answer.engine) ?? 0) + 1);
    }
    // A grounded answer marks the engine grounded for weighting.
    if (answer.kind === 'grounded' || !kinds.has(answer.engine)) {
      kinds.set(answer.engine, answer.kind);
    }
  });

  return order.map((engine) => {
    const kind = kinds.get(engine) ?? 'parametric';
    return scoreEngine(
      engine,
      kind,
      grouped.get(engine) ?? [],
      // Only meaningful for a grounded engine; a parametric one ran no search
      // by definition, and a 0 there would read as a failed retrieval.
      kind === 'grounded' ? (retrieved.get(engine) ?? 0) : undefined,
    );
  });
}
