/**
 * Diff two snapshots (M8): what a brand won or lost between two `check` runs.
 *
 * Prompt identity is the prompt text, which is stable across runs because
 * queries only regenerate on `--regenerate` (M5). If the two runs asked
 * different prompt sets (a regenerated or hand-edited pack), the comparison is
 * no longer apples-to-apples: {@link SnapshotDiff.promptSetChanged} is set, and
 * won/lost are computed ONLY over prompts present in both runs so a
 * added/removed prompt is never mislabeled as a win/loss.
 *
 * A prompt counts as "mentioned" for an engine when the brand appears in ANY of
 * that engine's answers to it - the presence signal a won/lost flip tracks.
 * Pure and deterministic (results sorted).
 *
 * Direction is explicit: `a` is the earlier baseline, `b` the later run, and the
 * result labels `from: a.generatedAt` / `to: b.generatedAt`. Passing them
 * reversed yields a valid backwards-in-time diff (from > to), not a wrong one.
 */
import type { EngineId, MentionResult } from '../types.js';
import { isPartialRun, type VisibilityEnvelope } from './envelope.js';
import { SCHEMA_VERSION } from '../types.js';

/** Per-engine change between two snapshots. */
export interface EngineDiff {
  engine: EngineId;
  /** `b.score - a.score` for this engine. */
  scoreDelta: number;
  /** Prompts (in both runs) newly mentioned in b. */
  wonPrompts: string[];
  /** Prompts (in both runs) no longer mentioned in b. */
  lostPrompts: string[];
}

/** The change between two snapshots (M8). */
export interface SnapshotDiff {
  schema_version: string;
  domain: string;
  /** `generatedAt` of the earlier (baseline) snapshot. */
  from: string;
  /** `generatedAt` of the later snapshot. */
  to: string;
  /** Headline AI Visibility Score delta (`b.score - a.score`). */
  scoreDelta: number;
  /** Per-engine changes, for engines present in BOTH runs (sorted by id). */
  engines: EngineDiff[];
  /**
   * True when the two runs asked different prompt sets; deltas are then not
   * apples-to-apples and won/lost cover only the shared prompts.
   */
  promptSetChanged: boolean;
  /**
   * True when an engine appeared in only one run (e.g. a key expired). The
   * headline `scoreDelta` then partly reflects an engine leaving the sample,
   * not a visibility change - and `engines` has no row for the missing one.
   */
  engineSetChanged: boolean;
  /**
   * True when the two runs used different scoring methodologies (or one predates
   * scoring versioning). The `scoreDelta` is then methodology-driven, not a real
   * visibility move (rule #2).
   */
  scoringChanged: boolean;
  /**
   * True when either compared run was partial (cost-capped, degraded, or
   * skipped engines). The delta is then not a full-confidence change (rule #6).
   */
  partial: boolean;
}

/** All distinct prompts an engine answered, prompt -> mentioned-in-any-answer. */
function promptMentions(
  mentions: MentionResult[],
  engine: EngineId,
): Map<string, boolean> {
  const byPrompt = new Map<string, boolean>();
  for (const m of mentions) {
    if (m.engine !== engine) continue;
    byPrompt.set(m.prompt, (byPrompt.get(m.prompt) ?? false) || m.mentioned);
  }
  return byPrompt;
}

function distinctPrompts(mentions: MentionResult[]): Set<string> {
  return new Set(mentions.map((m) => m.prompt));
}

function enginesIn(env: VisibilityEnvelope): Set<EngineId> {
  return new Set(env.engines.map((e) => e.engine));
}

/**
 * Compute the diff of snapshot `a` (baseline) against `b` (later). Throws when
 * the two snapshots are for different domains - a shared state directory can
 * hold snapshots for more than one brand, and a cross-brand diff would be
 * silently meaningless.
 */
export function diffEnvelopes(
  a: VisibilityEnvelope,
  b: VisibilityEnvelope,
): SnapshotDiff {
  if (a.domain !== b.domain) {
    throw new Error(
      `Cannot diff snapshots for different domains: "${a.domain}" vs "${b.domain}".`,
    );
  }

  const aScores = new Map(a.engines.map((e) => [e.engine, e.score]));
  const bScores = new Map(b.engines.map((e) => [e.engine, e.score]));

  // Only engines present in BOTH runs can be diffed prompt-for-prompt.
  const aEngines = enginesIn(a);
  const bEngines = enginesIn(b);
  const sharedEngines = [...aEngines].filter((e) => bEngines.has(e)).sort();

  const engines: EngineDiff[] = sharedEngines.map((engine) => {
    const aMentions = promptMentions(a.mentions, engine);
    const bMentions = promptMentions(b.mentions, engine);
    const wonPrompts: string[] = [];
    const lostPrompts: string[] = [];
    // Restrict to prompts asked in BOTH runs so pack edits are not flips.
    for (const [prompt, aMentioned] of aMentions) {
      if (!bMentions.has(prompt)) continue;
      const bMentioned = bMentions.get(prompt) ?? false;
      if (bMentioned && !aMentioned) wonPrompts.push(prompt);
      if (!bMentioned && aMentioned) lostPrompts.push(prompt);
    }
    return {
      engine,
      scoreDelta: (bScores.get(engine) ?? 0) - (aScores.get(engine) ?? 0),
      wonPrompts: wonPrompts.sort(),
      lostPrompts: lostPrompts.sort(),
    };
  });

  const aPrompts = distinctPrompts(a.mentions);
  const bPrompts = distinctPrompts(b.mentions);
  const promptSetChanged =
    aPrompts.size !== bPrompts.size ||
    [...aPrompts].some((p) => !bPrompts.has(p));

  const engineSetChanged =
    aEngines.size !== bEngines.size ||
    [...aEngines].some((e) => !bEngines.has(e));

  return {
    schema_version: SCHEMA_VERSION,
    domain: b.domain,
    from: a.generatedAt,
    to: b.generatedAt,
    scoreDelta: b.score - a.score,
    engines,
    promptSetChanged,
    engineSetChanged,
    scoringChanged: a.scoringVersion !== b.scoringVersion,
    partial: isPartialRun(a) || isPartialRun(b),
  };
}
