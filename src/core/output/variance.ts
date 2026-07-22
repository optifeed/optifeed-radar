/**
 * Retrieval-variance honesty framing (M7), shared by the terminal and HTML
 * renderers so both surface the same caveat. A high-variance engine's score is
 * a wider estimate (Profound fanout study); this is framing only and never
 * changes the number (rule #6).
 */
import { retrievalVariance } from '../scoring/index.js';
import type { EngineScore } from '../types.js';

/** The marker appended to a wider-estimate engine's line. */
export const VARIANCE_MARKER = '*';

/**
 * True when this engine's score is a wider estimate: it actually retrieved and
 * has high run-to-run retrieval variance. The retrieval gate is the honesty
 * point - an answer that ran no search cannot have "rewritten your prompt
 * before searching", whether it was parametric or grounded-in-name-only (rule
 * #6). A grounded score with no `retrievedAnswers` count predates the
 * measurement, so it keeps the old reading.
 */
export function isWiderEstimate(e: EngineScore): boolean {
  if (e.kind !== 'grounded') return false;
  if (e.retrievedAnswers === 0) return false;
  return retrievalVariance(e.engine) === 'high';
}

/**
 * "searched in 1 of 8 answers" - shown when a grounded engine did NOT retrieve
 * on every answer. Empty when it retrieved on all of them (nothing to
 * disclose) or when the count was never measured. Without this the reader sees
 * "grounded" and assumes every answer was retrieval-backed.
 */
export function retrievalLine(e: EngineScore): string {
  if (e.kind !== 'grounded' || e.retrievedAnswers === undefined) return '';
  if (e.retrievedAnswers >= e.answers) return '';
  return `searched in ${e.retrievedAnswers} of ${e.answers} answers`;
}

/**
 * The honest caveat for `count` wider-estimate engines, singular/plural aware.
 * Empty string when none - callers omit the note entirely.
 */
export function varianceNote(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? 'this engine varies more run to run (it rewrites your prompt before ' +
        'searching), so treat its score as a wider estimate.'
    : 'these engines vary more run to run (they rewrite your prompt before ' +
        'searching), so treat their scores as wider estimates.';
}
