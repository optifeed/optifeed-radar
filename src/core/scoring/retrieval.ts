/**
 * Did an answer ACTUALLY retrieve, and what is that worth (M7)?
 *
 * `EngineAnswer.kind` records the mode that was REQUESTED, not what happened.
 * A grounded-mode call is a request the model can decline: on the 2026-07-20
 * live run, 7 of 8 OpenAI answers ran no search and cited nothing, yet all 8
 * were tagged `grounded` and so earned the full 1.5x composite premium. That
 * premium exists to reward retrieval-backed answers, so an answer written from
 * the model's weights has not earned it (rule #6).
 *
 * The weighting is a strict generalization of the old rule, not a new one: an
 * engine whose answers all retrieved still weighs 1.5x, a parametric engine
 * still weighs 1.0x, and only the mislabeled middle moves.
 */
import type { EngineAnswer, EngineId } from '../types.js';

/**
 * Engines whose grounded answers report retrieval evidence - the search
 * queries they ran, the sources they cited, or both. Only for these can a lack
 * of evidence be read as "did not search"; for anything else absence of
 * evidence is not evidence of absence, so the requested kind is trusted.
 *
 * Verified live 2026-07-20: openai reports queries + citations, gemini reports
 * both, perplexity reports citations only (it never exposes its queries).
 */
export const RETRIEVAL_EVIDENCE_ENGINES: Partial<Record<EngineId, true>> = {
  openai: true,
  gemini: true,
  perplexity: true,
};

/** Whether this answer shows evidence of an actual retrieval. */
export function answerRetrieved(answer: EngineAnswer): boolean {
  if (answer.kind !== 'grounded') return false;
  if (!RETRIEVAL_EVIDENCE_ENGINES[answer.engine]) return true;
  return (
    (answer.fanoutQueries?.length ?? 0) > 0 ||
    (answer.citations?.length ?? 0) > 0
  );
}

/**
 * How many of these answers actually retrieved. Counted per engine at scoring
 * time; `effectiveWeight` (in `score.ts`, which owns the weights) turns it into
 * the share of the grounded premium the engine has earned.
 */
export function countRetrieved(answers: EngineAnswer[]): number {
  return answers.filter(answerRetrieved).length;
}
