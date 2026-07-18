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
 * True when this engine's score is a wider estimate: it actually ran GROUNDED
 * and the engine has high run-to-run retrieval variance. The grounded gate is
 * the honesty point - a parametric answer ran no search, so the "rewrites your
 * prompt before searching" framing would be false for it (rule #6).
 */
export function isWiderEstimate(e: EngineScore): boolean {
  return e.kind === 'grounded' && retrievalVariance(e.engine) === 'high';
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
