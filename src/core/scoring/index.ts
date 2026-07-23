/**
 * Public API of the scoring module (M7). Import from `core/scoring`.
 *
 * Engine answers in, the AI Visibility Score out: deterministic pass-1 mention
 * detection, a budgeted judge pass 2, per-engine + composite scoring, share of
 * voice, and cited-source aggregation. The published formula lives in
 * `METHODOLOGY.md`; {@link SCORE_WEIGHTS} is its source of truth.
 */
export { analyzeAnswer, fold } from './detect.js';
export {
  scoreEngine,
  compositeScore,
  shareOfVoice,
  aggregateSources,
  SCORE_WEIGHTS,
  RETRIEVAL_STABILITY,
  retrievalVariance,
} from './score.js';
export { refineAmbiguous, parseVerdict, JUDGE_RATE_CAP } from './judge.js';
export type { RefineDeps, RefineOptions, RefineResult } from './judge.js';
export { scoreAnswers, scorePerEngine } from './scoring.js';
export type { ScoreDeps, ScoreOptions } from './scoring.js';
