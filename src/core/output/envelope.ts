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
 * CLI, M12 shopping, M15 MCP) reads THIS shape and never re-derives from raw
 * data. Pure: the timestamp is injected, so builds are deterministic (the
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
  type RunHonesty,
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
  /** THE headline AI Visibility Score, 0-100 (hard rule #6). */
  score: number;
  /** Per-engine scores (M7). */
  engines: EngineScore[];
  /** Share-of-voice vs competitors (M7). */
  shareOfVoice: ShareOfVoiceRow[];
  /** Cited-source aggregation across grounded answers (M7). */
  sources: SourceRow[];
  /** Per-answer mention detail; the prompt identity that {@link diffEnvelopes} reads. */
  mentions: MentionResult[];
  /** Raw engine answers - the evidence M9 renders behind expandable sections. */
  answers: EngineAnswer[];
  /** Audit findings (M3) surfaced inside check, never the audit score (rule #6). */
  findings: Finding[];
  sampling: EnvelopeSampling;
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  degraded?: boolean;
}

/**
 * Whether a run's score is a partial sample rather than a full-confidence
 * measurement: cost-capped, degraded, or missing whole engines. The single
 * source of truth for {@link failUnder} and {@link diffEnvelopes} so they never
 * present a partial run as complete (hard rule #6).
 */
export function isPartialRun(
  run: Pick<VisibilityEnvelope, 'costCapped' | 'degraded' | 'skippedEngines'>,
): boolean {
  return (
    run.costCapped === true ||
    run.degraded === true ||
    (run.skippedEngines?.length ?? 0) > 0
  );
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
  /** Injected timestamp so builds are deterministic. */
  generatedAt: string;
}

/** Assemble the stable check envelope from the pipeline's outputs. */
export function buildEnvelope(input: BuildEnvelopeInput): VisibilityEnvelope {
  const { profile, score, answers, auditFindings, honesty, generatedAt } =
    input;

  const nPrompts = new Set(answers.map((a) => a.prompt)).size;

  const envelope: VisibilityEnvelope = {
    schema_version: SCHEMA_VERSION,
    generatedAt,
    domain: profile.domain,
    profile,
    score: score.score,
    engines: score.engines,
    shareOfVoice: score.shareOfVoice,
    sources: score.sources,
    mentions: score.mentions,
    answers,
    findings: auditFindings ?? [],
    sampling: {
      nPrompts,
      nAnswers: score.sampling.answers,
      judged: score.sampling.judged,
      varianceNote: VARIANCE_NOTE,
    },
  };

  // Only attach honesty flags that are actually set, so a clean run's envelope
  // stays clean (partial runs are never hidden, but clean runs aren't muddied).
  if (honesty?.costCapped) envelope.costCapped = true;
  if (honesty?.degraded) envelope.degraded = true;
  if (honesty?.skippedEngines && honesty.skippedEngines.length > 0) {
    envelope.skippedEngines = honesty.skippedEngines;
  }

  return envelope;
}
