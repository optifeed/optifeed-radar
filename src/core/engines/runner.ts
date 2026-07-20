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
      // What this engine has ACTUALLY cost so far. The static per-call estimate
      // assumes 500 output tokens; live, Gemini averaged 2584 (thinking tokens
      // bill as output), so every authorization was ~5x too small and a whole
      // concurrent wave could be admitted against headroom that could not pay
      // for it. Once a call has completed we know better, so authorize against
      // the observed cost (hard rule #5: respect --max-cost).
      let observedTotal = 0;
      let observedCount = 0;
      const projectedCost = (): number => {
        const observedAvg =
          observedCount > 0 ? observedTotal / observedCount : 0;
        return Math.max(estimateCall(adapter.model), observedAvg);
      };

      const askOne = async (prompt: string): Promise<Settled> => {
        {
          const guard = opts.guard;
          // Enforce the hard cost cap at the spend site: authorize (and thereby
          // RESERVE) a projected per-call cost before asking; once it trips,
          // `authorize` sets `costCapped` and we stop asking (partial run,
          // never over-spend hard).
          let reserved = 0;
          if (guard) {
            if (guard.costCapped) {
              opts.onAnswered?.();
              return { kind: 'capped' };
            }
            reserved = projectedCost();
            if (!guard.authorize(reserved)) {
              opts.onAnswered?.();
              return { kind: 'capped' };
            }
          }
          try {
            const answer = await adapter.ask(prompt, { mode: opts.mode });
            // Settle, never record: settling releases the reservation this call
            // is holding and books the real figure in its place.
            guard?.settle(reserved, answer.costUsd);
            observedTotal += answer.costUsd;
            observedCount += 1;
            return { kind: 'ok', answer };
          } catch (err) {
            // A failed call cost nothing; free its hold so a few errors do not
            // strangle the remaining budget.
            guard?.settle(reserved, 0);
            return {
              kind: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
          } finally {
            // ok/error settle here; the capped paths above reported already, so
            // every call ticks exactly once.
            opts.onAnswered?.();
          }
        }
      };

      // Probe with ONE call before fanning out, but only when a guard is
      // enforcing a budget. The first wave has no observed cost to authorize
      // against, so `concurrency` calls would all reserve the stale static
      // estimate at once - live, that alone kept a 74% cap breach at 28%. One
      // sequential call buys a real measurement for the price of a single round
      // trip, and every later authorization is then accurate. With no guard
      // there is nothing to protect, so the full fan-out runs unchanged.
      const settled: Settled[] = [];
      let remaining = prompts;
      if (opts.guard && prompts.length > 1) {
        settled.push(await askOne(prompts[0]!));
        remaining = prompts.slice(1);
      }
      settled.push(
        ...(await mapLimit<string, Settled>(remaining, concurrency, askOne)),
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

      // PARTIAL: this engine answered fewer prompts than the run asked. Two
      // independent causes, and BOTH must be reported:
      //   - calls that errored (e.g. a rate-limited key)
      //   - calls the cost guard refused to send
      // Gating on errors alone missed cap-truncated engines entirely: adapters
      // fan out concurrently against one global `costCapped` flag, so engine A
      // can answer 8/8 while engine B answers 1/8, and the only trace was a
      // run-level cap note naming no engine and carrying no counts. Attributing
      // cap-refused prompts to the first ERROR would also be a false statement
      // about why the sample is thin, so the reason names each cause that
      // actually fired (rule #6, lesson #7).
      const capped = settled.filter((s) => s.kind === 'capped').length;
      if (answersForAdapter.length < prompts.length) {
        const reasons: string[] = [];
        if (errors.length > 0) {
          reasons.push(errors[0]?.error ?? 'some requests failed');
        }
        if (capped > 0) {
          reasons.push(`cost cap reached (${capped} not sent)`);
        }
        return {
          answers: answersForAdapter,
          skip: undefined,
          partial: {
            engine: adapter.id,
            // Prompts the RUN asked for - the denominator the engine's score is
            // measured against, not just the calls that left the process.
            attempted: prompts.length,
            answered: answersForAdapter.length,
            reason: reasons.join('; ') || 'some prompts were not answered',
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
