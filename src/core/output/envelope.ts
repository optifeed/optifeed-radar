/**
 * The M8 output data contract: one stable shape every consumer reads.
 *
 * `buildEnvelope` wraps M7's {@link ScoreReport} (the headline AI Visibility
 * Score, per-engine scores, share of voice, cited sources, per-answer mention
 * detail) together with the M4 {@link BrandProfile}, the raw M6 answers (the
 * evidence M9 renders), M3 audit findings, and the run's honesty flags.
 *
 * Hard rule #6: the ONE headline number is M7's `score`. The audit's own 0-100
 * (M3) never competes with it inside `check` - audit observations arrive here
 * only as {@link Finding}s. Everything downstream (M9 renderers, M10 run, M11
 * CLI, M15 MCP) reads THIS shape and never re-derives from raw data. Pure: the timestamp is injected, so builds are deterministic (the
 * schema snapshot test depends on it).
 */
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineScore,
  type EngineId,
  type Finding,
  type MentionResult,
  type PartialEngine,
  type Reputation,
  type RunHonesty,
  type RunSpend,
  type ScoreReport,
  type ShareOfVoiceRow,
  type SourceRow,
} from '../types.js';

/**
 * Honest single line about score precision (messaging guide: no fake
 * precision, no em-dash). Scores are estimates from a small sample.
 */
export const VARIANCE_NOTE =
  'This score is an estimate from a limited sample of buyer prompts and will vary between runs.';

/** The sampling context that keeps the score honest. */
export interface EnvelopeSampling {
  /** Distinct buyer prompts asked this run. */
  nPrompts: number;
  /** Total engine answers analyzed (prompts x engines, minus skips). */
  nAnswers: number;
  /** Answers re-checked by the judge pass (pass 2). */
  judged: number;
  /** Honest caveat shown wherever the score appears. */
  varianceNote: string;
}

/** The stable `check` envelope every consumer reads (M8). */
export interface VisibilityEnvelope {
  schema_version: string;
  generatedAt: string;
  domain: string;
  /** The buyer profile this run scored against (M4). */
  profile: BrandProfile;
  /**
   * THE headline AI Visibility Score, 0-100 (hard rule #6).
   *
   * `null` when the run measured nothing (no engine answered) - rendered as
   * "not assessed", never as a 0. See {@link isPartialRun}, which treats a null
   * score as partial so no derived artifact relaunders it as a real result.
   */
  score: number | null;
  /**
   * Scoring methodology version, so a diff can flag cross-version deltas
   * (rule #2). Optional because snapshots written before this field existed
   * still load (and read as "changed" against a versioned run).
   */
  scoringVersion?: number;
  /** Per-engine scores (M7). */
  engines: EngineScore[];
  /** Share-of-voice vs competitors (M7). */
  shareOfVoice: ShareOfVoiceRow[];
  /** Cited-source aggregation across grounded answers (M7). */
  sources: SourceRow[];
  /** Sentiment from branded prompts, reported apart from the score. Absent if none. */
  reputation?: Reputation;
  /** Per-answer mention detail; the prompt identity that {@link diffEnvelopes} reads. */
  mentions: MentionResult[];
  /** Raw engine answers - the evidence M9 renders behind expandable sections. */
  answers: EngineAnswer[];
  /** Audit findings (M3) surfaced inside check, never the audit score (rule #6). */
  findings: Finding[];
  sampling: EnvelopeSampling;
  /**
   * What the run actually spent (from the cost guard).
   *
   * Optional because snapshots written before this field existed still load,
   * and because a caller may build an envelope with no guard. Absent means "not
   * recorded" and renders as nothing at all - never as $0.00, which would claim
   * a paid run was free (the same rule that renders an unmeasured score as
   * "not assessed" rather than 0).
   */
  spend?: RunSpend;
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  /** Engines that answered only some prompts, with their real sample counts. */
  partialEngines?: PartialEngine[];
  degraded?: boolean;
}

/**
 * Anything a run produced that carries honesty flags: the check envelope, the
 * shopping envelope (M12a), and any future artifact with the same signals.
 *
 * Structural rather than a `Pick` of one envelope so the ONE partial predicate
 * serves every artifact - the M8 lesson is that a second, hand-rolled version of
 * this check eventually enumerates a SUBSET of the signals and relaunders a
 * partial run as complete.
 */
export interface PartialRunLike {
  costCapped?: boolean;
  degraded?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  partialEngines?: PartialEngine[];
  /**
   * The headline score, for artifacts that have one. `null` means the run
   * measured nothing; absent means this artifact has no single score (a
   * shopping run reports a ranking delta and per-product numbers instead).
   */
  score?: number | null;
}

/**
 * Whether a run's score is a partial sample rather than a full-confidence
 * measurement: cost-capped, degraded, missing whole engines, or an engine that
 * answered only some prompts. The single
 * source of truth for {@link failUnder} and {@link diffEnvelopes} so they never
 * present a partial run as complete (hard rule #6).
 */
export function isPartialRun(run: PartialRunLike): boolean {
  return (
    run.costCapped === true ||
    run.degraded === true ||
    (run.skippedEngines?.length ?? 0) > 0 ||
    // An engine that answered only some prompts is scored on a thinner sample
    // than its neighbours. Without this the run reads as complete (found live
    // 2026-07-20: 1 of 8 answers, every other flag unset).
    (run.partialEngines?.length ?? 0) > 0 ||
    // A run that measured nothing is the MOST partial run there is. Counting it
    // here (rather than at each call site) is why `failUnder` and `diff` cannot
    // present an unassessed run as a complete one - the M8 lesson: one shared
    // predicate, every flag, no hand-rolled subsets.
    run.score === null
  );
}

/**
 * The honesty flags of a run, as a projectable object - only the flags that are
 * actually set, ready to spread into any JSON payload.
 *
 * Exists because consumers kept hand-rolling the projection and enumerating a
 * SUBSET: `sources --json` spread costCapped/degraded/skippedEngines and
 * silently dropped `partialEngines` the moment it was added, so one snapshot
 * rendered as partial in text and as complete in JSON. Anything serialising
 * honesty must call this rather than listing fields, so the NEXT signal is
 * carried automatically (hard rule #6).
 */
export function honestyFields(env: PartialRunLike): Partial<RunHonesty> {
  const out: Partial<RunHonesty> = {};
  if (env.costCapped) out.costCapped = true;
  if (env.degraded) out.degraded = true;
  if (env.skippedEngines && env.skippedEngines.length > 0) {
    out.skippedEngines = env.skippedEngines;
  }
  if (env.partialEngines && env.partialEngines.length > 0) {
    out.partialEngines = env.partialEngines;
  }
  return out;
}

/**
 * Which honesty signals actually fired, as human-readable cause names. Callers
 * that explain WHY a run is partial must interpolate this rather than hardcode
 * a list - the hardcoded "cost-capped, degraded, or missing engines" wording
 * named three causes after a fourth existed, so a partialEngines-only run was
 * explained by three things that did not happen.
 */
export function partialCauses(run: PartialRunLike): string[] {
  const causes: string[] = [];
  if (run.score === null) causes.push('nothing measured');
  if (run.costCapped === true) causes.push('cost-capped');
  if (run.degraded === true) causes.push('degraded profile');
  if ((run.skippedEngines?.length ?? 0) > 0) causes.push('engines skipped');
  if ((run.partialEngines?.length ?? 0) > 0) {
    causes.push('an engine answered only some prompts');
  }
  return causes;
}

/** Inputs to {@link buildEnvelope}. */
export interface BuildEnvelopeInput {
  profile: BrandProfile;
  score: ScoreReport;
  /** Raw answers carried as evidence for the renderers (no re-derive). */
  answers: EngineAnswer[];
  /** Audit findings (M3); absent on a check with no audit pass. */
  auditFindings?: Finding[];
  /** Run honesty flags; absent when the run was clean. */
  honesty?: RunHonesty;
  /** What the run spent, from the cost guard. Absent when it was not costed. */
  spend?: RunSpend;
  /** Injected timestamp so builds are deterministic. */
  generatedAt: string;
}

/** Assemble the stable check envelope from the pipeline's outputs. */
export function buildEnvelope(input: BuildEnvelopeInput): VisibilityEnvelope {
  const {
    profile,
    score,
    answers,
    auditFindings,
    honesty,
    spend,
    generatedAt,
  } = input;

  // Sampling describes the SCORE's sample, so count the discovery prompts that
  // fed it (branded prompts are summarized in `reputation`, not the score). For
  // a run with no branded prompts this equals every prompt asked.
  const nPrompts = new Set(score.mentions.map((m) => m.prompt)).size;

  const envelope: VisibilityEnvelope = {
    schema_version: SCHEMA_VERSION,
    generatedAt,
    domain: profile.domain,
    profile,
    score: score.score,
    scoringVersion: score.scoringVersion,
    engines: score.engines,
    shareOfVoice: score.shareOfVoice,
    sources: score.sources,
    mentions: score.mentions,
    answers,
    findings: auditFindings ?? [],
    ...(score.reputation ? { reputation: score.reputation } : {}),
    sampling: {
      nPrompts,
      nAnswers: score.sampling.answers,
      judged: score.sampling.judged,
      varianceNote: VARIANCE_NOTE,
    },
    // Attached only when the run was costed. An absent figure means "not
    // recorded"; writing a 0 would claim a paid run was free.
    ...(spend ? { spend } : {}),
  };

  // Only attach honesty flags that are actually set, so a clean run's envelope
  // stays clean (partial runs are never hidden, but clean runs aren't muddied).
  if (honesty?.costCapped) envelope.costCapped = true;
  if (honesty?.degraded) envelope.degraded = true;
  if (honesty?.skippedEngines && honesty.skippedEngines.length > 0) {
    envelope.skippedEngines = honesty.skippedEngines;
  }
  if (honesty?.partialEngines && honesty.partialEngines.length > 0) {
    envelope.partialEngines = honesty.partialEngines;
  }

  return envelope;
}
