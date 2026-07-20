/**
 * Fan prompts across adapters, partial-failure tolerant (M6).
 *
 * One adapter's total failure never kills the run - it is moved to
 * `skippedEngines` with a reason. An adapter that answers only SOME prompts is
 * reported separately in `partialEngines` with its real counts, so a score
 * resting on a thinner sample is never presented as full confidence (rule #6).
 * Per-provider concurrency is bounded; per-call cost is recorded into an
 * optional CostGuard.
 */
import {
  type CostGuard,
  ESTIMATE_ASSUMPTIONS,
  MODEL_PRICING,
  costOfCall,
} from '../costs.js';
import type { EngineAnswer, EngineId, PartialEngine } from '../types.js';
import type { AskMode, EngineAdapter } from './adapter.js';

export interface SkippedEngine {
  engine: EngineId;
  reason: string;
}

export interface AskAllResult {
  answers: EngineAnswer[];
  skippedEngines: SkippedEngine[];
  /**
   * Engines that answered some but not all prompts. Total failure lands in
   * {@link AskAllResult.skippedEngines} instead - the two are separate signals.
   */
  partialEngines: PartialEngine[];
}

export interface AskAllOptions {
  mode?: AskMode;
  guard?: CostGuard;
  /** Max concurrent requests per provider (default 4). */
  concurrency?: number;
  /**
   * Called once per individual engine call as it settles (ok, error, or
   * capped), for progress reporting. Pure side-channel - never affects results.
   */
  onAnswered?: () => void;
}

/** Run `fn` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

type Settled =
  | { kind: 'ok'; answer: EngineAnswer }
  | { kind: 'error'; error: string }
  | { kind: 'capped' };

/** Rough per-call cost for the pre-ask cap check (real cost is recorded after). */
function estimateCall(model: string): number {
  const pricing = MODEL_PRICING.models[model];
  if (!pricing) return 0;
  return costOfCall(
    pricing,
    ESTIMATE_ASSUMPTIONS.avgInputTokens,
    ESTIMATE_ASSUMPTIONS.avgOutputTokens,
  );
}

export async function askAll(
  prompts: string[],
  adapters: EngineAdapter[],
  opts: AskAllOptions = {},
): Promise<AskAllResult> {
  const concurrency = opts.concurrency ?? 4;
  const skippedEngines: SkippedEngine[] = [];
  const partialEngines: PartialEngine[] = [];
  const answers: EngineAnswer[] = [];

  const available: EngineAdapter[] = [];
  for (const adapter of adapters) {
    if (adapter.available()) available.push(adapter);
    else skippedEngines.push({ engine: adapter.id, reason: 'no API key' });
  }

  const perAdapter = await Promise.all(
    available.map(async (adapter) => {
      const settled = await mapLimit<string, Settled>(
        prompts,
        concurrency,
        async (prompt) => {
          const guard = opts.guard;
          // Enforce the hard cost cap at the spend site: authorize an estimated
          // per-call cost before asking; once it trips, `authorize` sets
          // `costCapped` and we stop asking (partial run, never over-spend hard).
          if (guard) {
            if (guard.costCapped) {
              opts.onAnswered?.();
              return { kind: 'capped' };
            }
            if (!guard.authorize(estimateCall(adapter.model))) {
              opts.onAnswered?.();
              return { kind: 'capped' };
            }
          }
          try {
            const answer = await adapter.ask(prompt, { mode: opts.mode });
            guard?.record(answer.costUsd);
            return { kind: 'ok', answer };
          } catch (err) {
            return {
              kind: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
          } finally {
            // ok/error settle here; the capped paths above reported already, so
            // every call ticks exactly once.
            opts.onAnswered?.();
          }
        },
      );

      const answersForAdapter = settled
        .filter(
          (s): s is { kind: 'ok'; answer: EngineAnswer } => s.kind === 'ok',
        )
        .map((s) => s.answer);
      const errors = settled.filter(
        (s): s is { kind: 'error'; error: string } => s.kind === 'error',
      );

      // Total failure = every attempt errored. A cost-capped run is not an
      // engine failure, so it never marks the engine skipped.
      if (
        prompts.length > 0 &&
        answersForAdapter.length === 0 &&
        errors.length > 0
      ) {
        return {
          answers: answersForAdapter,
          skip: {
            engine: adapter.id,
            reason: errors[0]?.error ?? 'all requests failed',
          },
          partial: undefined,
        };
      }

      // PARTIAL failure: some answered, some errored. Previously `errors` was
      // computed here and then discarded, so an engine that answered 1 of 8 was
      // scored on that single sample and the run reported no honesty flag at all
      // (found live 2026-07-20 against a rate-limited Gemini key). Surface it as
      // its own signal - the engine was not skipped, but its score is thinner
      // than the per-engine table alone suggests (rule #6, lesson #7).
      if (errors.length > 0) {
        return {
          answers: answersForAdapter,
          skip: undefined,
          partial: {
            engine: adapter.id,
            attempted: prompts.length,
            answered: answersForAdapter.length,
            reason: errors[0]?.error ?? 'some requests failed',
          },
        };
      }

      return {
        answers: answersForAdapter,
        skip: undefined,
        partial: undefined,
      };
    }),
  );

  for (const result of perAdapter) {
    if (result.skip) skippedEngines.push(result.skip);
    if (result.partial) partialEngines.push(result.partial);
    answers.push(...result.answers);
  }

  return { answers, skippedEngines, partialEngines };
}
