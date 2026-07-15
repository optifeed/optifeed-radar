/**
 * The `--fail-under <n>` CI gate (M8): a pure predicate turning a run's
 * headline score into an exit code.
 *
 * Honest: a cost-capped, degraded, or engine-skipping run produces a partial
 * score, so the result is flagged {@link FailUnderResult.partial} and says so -
 * the caller (M11 CLI) decides how loudly to surface it, but the number is
 * never presented as a full-confidence measurement.
 */
import { isPartialRun, type VisibilityEnvelope } from './envelope.js';

/** Outcome of a `--fail-under` check. */
export interface FailUnderResult {
  /** Whether the gate passed (no threshold, or score >= threshold). */
  passed: boolean;
  /** Process exit code: 0 pass, 1 fail (CI convention). */
  exitCode: number;
  /** The run was partial (cost-capped, degraded, or skipped engines); the score is an incomplete sample. */
  partial: boolean;
  /** Human-readable one-liner explaining the outcome. */
  reason: string;
}

/**
 * Evaluate the `--fail-under` gate. With no threshold the gate always passes.
 */
export function failUnder(
  envelope: VisibilityEnvelope,
  threshold?: number,
): FailUnderResult {
  const partial = isPartialRun(envelope);
  const partialNote = partial
    ? ' Note: this run was partial (cost-capped, degraded, or missing engines), so the score is an incomplete sample.'
    : '';

  if (threshold === undefined) {
    return {
      passed: true,
      exitCode: 0,
      partial,
      reason: `No --fail-under threshold set; score ${envelope.score}.${partialNote}`,
    };
  }

  const passed = envelope.score >= threshold;
  return {
    passed,
    exitCode: passed ? 0 : 1,
    partial,
    reason: passed
      ? `Score ${envelope.score} meets the --fail-under threshold of ${threshold}.${partialNote}`
      : `Score ${envelope.score} is under the --fail-under threshold of ${threshold}.${partialNote}`,
  };
}
