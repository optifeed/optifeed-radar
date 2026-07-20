/**
 * The `--fail-under <n>` CI gate (M8): a pure predicate turning a run's
 * headline score into an exit code.
 *
 * Honest: any run flagged partial by `isPartialRun` (cost cap, degraded profile,
 * skipped engines, or an engine that answered only some prompts) produces a partial
 * score, so the result is flagged {@link FailUnderResult.partial} and says so -
 * the caller (M11 CLI) decides how loudly to surface it, but the number is
 * never presented as a full-confidence measurement.
 */
import {
  isPartialRun,
  partialCauses,
  type VisibilityEnvelope,
} from './envelope.js';

/** Outcome of a `--fail-under` check. */
export interface FailUnderResult {
  /** Whether the gate passed (no threshold, or score >= threshold). */
  passed: boolean;
  /** Process exit code: 0 pass, 1 fail (CI convention). */
  exitCode: number;
  /** The run was partial (see `partialCauses`); the score is an incomplete sample. */
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
  // Name the causes that ACTUALLY fired. The old wording hardcoded three, so a
  // run partial only because an engine answered some prompts was explained by
  // three things that did not happen (rule #6: no invented attribution).
  const partialNote = partial
    ? ` Note: this run was partial (${partialCauses(envelope).join(', ')}), so the score is an incomplete sample.`
    : '';

  // Nothing was measured. Never pass a gate on a run that produced no score:
  // passing would green-light a deploy off a total failure, and the fabricated
  // 0 this replaces would have failed every gate for the opposite wrong reason.
  // Say what is true instead - the run was not assessed (rule #6).
  if (envelope.score === null) {
    return {
      passed: false,
      exitCode: 1,
      partial: true,
      reason:
        'Not assessed: no engine returned an answer, so this run has no score. Nothing was measured, so the gate cannot pass.',
    };
  }

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
