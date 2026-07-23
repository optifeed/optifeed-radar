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
  assumedOutputTokens,
  costOfCall,
  priciestPricing,
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

/**
 * Safety factor applied to the reservation for a call whose engine has not yet
 * reported a real cost.
 *
 * `--max-cost` cannot be a perfect guarantee: a call's cost is unknowable until
 * it returns, and money already spent cannot be refused. What CAN be bounded is
 * the blind window - the first call per engine. Sized from live measurement
 * (2026-07-20): with corrected token assumptions, real first calls landed at up
 * to ~1.3x their reservation, so 1.5 covers the observed spread with a little
 * room. Over-reserving is cheap because `settle` returns the unused hold as
 * soon as the call completes; it costs a little parallelism near the cap, not
 * budget.
 */
export const UNMEASURED_CALL_MARGIN = 1.5;

/**
 * Rough per-call cost for the pre-ask cap check (real cost is recorded after).
 *
 * A grounded call also owes a per-search fee, which on a real Gemini call
 * exceeded the entire token cost. Reserving the token cost alone would admit
 * calls the budget cannot pay for - the same under-reservation shape as the
 * 74% breach found on 2026-07-20.
 */
function estimateCall(model: string, grounded: boolean): number {
  // An unpriced model must NOT read as free. Returning 0 here made every
  // `authorize(0)` succeed, so `--max-cost` was silently unenforceable for
  // that engine and the run could spend without bound against a cap the user
  // explicitly set. `estimateCallUsd` already documents the never-under-
  // estimate rule; this is the same rule, applied at the enforcement site.
  const pricing = MODEL_PRICING.models[model] ?? priciestPricing();
  return costOfCall(
    pricing,
    ESTIMATE_ASSUMPTIONS.avgInputTokens,
    // Per-model where known: the global 500 is ~5x under for thinking models,
    // which is what under-reserved the cap in the first place.
    assumedOutputTokens(pricing),
    grounded ? ESTIMATE_ASSUMPTIONS.searchesPerGroundedCall : 0,
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
      let observedCount = 0;
      let observedMax = 0;
      const projectedCost = (): number => {
        // `supportsGrounded` gates this the same way the adapter does: an
        // engine that cannot search is not reserved for searches it will never
        // run, even under --grounded (rule #6 - no fake precision).
        const willSearch =
          opts.mode === 'grounded' &&
          (adapter.kind === 'grounded' || adapter.supportsGrounded === true);

        // Blind: the cost is a GUESS, and a guess that lands low is money
        // already spent that the cap cannot claw back. Live 2026-07-20, even
        // with corrected token assumptions, first calls came in up to ~1.3x
        // their reservation and four concurrent engines each contributed one
        // such call, taking a $0.20 cap to $0.2322 - hence the margin.
        if (observedCount === 0) {
          return (
            estimateCall(adapter.model, willSearch) * UNMEASURED_CALL_MARGIN
          );
        }

        // Measured: reserve the DEAREST call this engine has actually made,
        // and stop consulting the static estimate entirely.
        //
        // Keeping the estimate as a floor (`Math.max(estimate, observedAvg)`)
        // meant the observed figure only ever took over when it was HIGHER,
        // so an estimate that ran high could never be corrected by reality.
        // Found live 2026-07-23 in three independent runs: a $0.30 cap spent
        // $0.048 and refused 4 of 8 prompts, and over MCP a $0.45 cap answered
        // gemini 2 of 8, leaving a headline score resting on two answers.
        // gpt-5.3-chat-latest estimates $0.0790 a call against a measured
        // ~$0.0117, so the cap was rationing against a number 6.75x too big.
        //
        // The MAX rather than the mean: costs vary per answer, and reserving
        // the dearest one seen keeps headroom for the next call being pricier
        // than average without reintroducing a number nothing measured.
        //
        // A SEARCHING call keeps the estimate as a floor, because there the
        // observed maximum is not a trustworthy ceiling: the per-search fee
        // dominates and its count swings hard. Live measurements show 2 to 6
        // searches on one engine, and OpenAI declining to search at all on 6
        // of 8 answers - so a no-search answer would set a low observedMax and
        // then badly under-reserve the next answer that runs six searches.
        // Under-reserving a fee-bearing call is exactly how --max-cost was
        // breached by 74% on 2026-07-20, so grounded keeps the safe number.
        if (willSearch) {
          return Math.max(observedMax, estimateCall(adapter.model, true));
        }
        return observedMax;
      };

      const askOne = async (prompt: string): Promise<Settled> => {
        {
          const guard = opts.guard;
          // Enforce the hard cost cap at the spend site: authorize (and thereby
          // RESERVE) a projected per-call cost before asking; a refusal sets
          // `costCapped` and this prompt goes unasked (partial run, never
          // over-spend hard).
          //
          // Deliberately does NOT short-circuit on `guard.costCapped`. That
          // flag latches to record that the cap refused something, but a
          // reservation is a projection: one concurrent wave can reserve past
          // the cap, settle far below it, and hand the headroom straight back.
          // Bailing out on the flag turned a transient spike into "abandon
          // every remaining prompt on every engine", yielding a thin sample and
          // a degraded score while reported spend sat well under the cap. Each
          // prompt is therefore offered to the guard on its own merits; when
          // the budget really is gone, `authorize` refuses and this returns
          // capped anyway - at the cost of one cheap in-memory call per prompt.
          let reserved = 0;
          if (guard) {
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
            observedMax = Math.max(observedMax, answer.costUsd);
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
      // Probing only learned from a SUCCESSFUL call, so one transient failure
      // on the first prompt sent the whole concurrent wave out against the
      // very estimate the probe exists to replace. Keep probing sequentially
      // until a call actually reports a cost (or the guard refuses, or we run
      // out of prompts) - the blast radius of a blind fan-out is every
      // in-flight call at once, while an extra sequential probe costs one
      // round trip.
      const settled: Settled[] = [];
      let remaining = prompts;
      if (opts.guard && prompts.length > 1) {
        let i = 0;
        while (i < prompts.length - 1 && observedCount === 0) {
          const outcome = await askOne(prompts[i]!);
          settled.push(outcome);
          i += 1;
          // A refusal means the budget is gone; further probing cannot help.
          if (outcome.kind === 'capped') break;
        }
        remaining = prompts.slice(i);
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
