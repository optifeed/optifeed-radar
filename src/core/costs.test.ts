import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_ASSUMPTIONS,
  CostGuard,
  MODEL_PRICING,
  UnknownModelError,
  costOfCall,
  estimateRun,
} from './costs.js';

describe('costOfCall', () => {
  it('prices a call from per-million-token rates', () => {
    const pricing = { inputPerMTokens: 1, outputPerMTokens: 2 };
    // 200 input tokens @ $1/M = 0.0002; 500 output @ $2/M = 0.001
    expect(costOfCall(pricing, 200, 500)).toBeCloseTo(0.0012, 10);
  });

  it('is zero for a zero-token call', () => {
    const pricing = { inputPerMTokens: 5, outputPerMTokens: 9 };
    expect(costOfCall(pricing, 0, 0)).toBe(0);
  });

  // Google bills grounding PER SEARCH QUERY, not per request: "A customer-
  // submitted request to Gemini may result in one or more queries to Google
  // Search. You will be charged for each individual search query performed."
  // (https://ai.google.dev/gemini-api/docs/pricing, retrieved 2026-07-20).
  // Token-only pricing misses this entirely.
  it('adds a per-search grounding fee when searches were performed', () => {
    const pricing = {
      inputPerMTokens: 1,
      outputPerMTokens: 2,
      perSearchUsd: 0.014,
    };
    // tokens 0.0012 + 3 searches @ $0.014 = 0.042 -> 0.0432
    expect(costOfCall(pricing, 200, 500, 3)).toBeCloseTo(0.0432, 10);
  });

  it('charges no grounding fee for a parametric call', () => {
    const pricing = {
      inputPerMTokens: 1,
      outputPerMTokens: 2,
      perSearchUsd: 0.014,
    };
    expect(costOfCall(pricing, 200, 500)).toBeCloseTo(0.0012, 10);
    expect(costOfCall(pricing, 200, 500, 0)).toBeCloseTo(0.0012, 10);
  });

  it('prices the search fee independently of the per-request fee', () => {
    // Perplexity bills flat per request; Google bills per search. A model with
    // both must not have one silently stand in for the other.
    const pricing = {
      inputPerMTokens: 0,
      outputPerMTokens: 0,
      perRequestUsd: 0.005,
      perSearchUsd: 0.014,
    };
    expect(costOfCall(pricing, 0, 0, 2)).toBeCloseTo(0.033, 10);
  });
});

describe('MODEL_PRICING', () => {
  it('carries a lastUpdated date and known models', () => {
    expect(MODEL_PRICING.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODEL_PRICING.models['gpt-4o-mini']).toBeDefined();
    // Every model this tool asks or judges with BY DEFAULT must be priced -
    // an unpriced default silently reports $0 spend (the M0-M6 lesson).
    expect(MODEL_PRICING.models['gpt-5.3-chat-latest']).toBeDefined();
    expect(MODEL_PRICING.models['gpt-5.4']).toBeDefined();
  });
});

describe('estimateRun', () => {
  it('sums ask cost across engines plus a sampled judge cost', () => {
    const askModel = 'gpt-4o-mini';
    const judgeModel = 'gpt-4o-mini';
    const est = estimateRun(5, [askModel, askModel], judgeModel);

    // Derive expected from the same pricing table so the test survives price edits.
    const pricing = MODEL_PRICING.models[askModel]!;
    const perAsk = costOfCall(
      pricing,
      est.assumptions.avgInputTokens,
      est.assumptions.avgOutputTokens,
    );
    const expectedAsk = 5 * 2 * perAsk;

    expect(est.askUsd).toBeCloseTo(expectedAsk, 10);
    expect(est.judgeUsd).toBeGreaterThan(0);
    expect(est.totalUsd).toBeCloseTo(est.askUsd + est.judgeUsd, 10);
  });

  // A grounded run pays a search fee per call that a parametric run does not.
  // The estimate must reflect it, or --max-cost authorizes against a number
  // that cannot pay for the run (the exact shape of the 74% breach found on
  // 2026-07-20, where the static estimate was 4.9x too small).
  it('prices grounding searches into a grounded estimate', () => {
    const parametric = estimateRun(10, ['gemini-flash-latest'], 'gpt-5.4');
    const grounded = estimateRun(10, ['gemini-flash-latest'], 'gpt-5.4', {
      ...ESTIMATE_ASSUMPTIONS,
      grounded: true,
    });

    const perSearch =
      MODEL_PRICING.models['gemini-flash-latest']!.perSearchUsd!;
    const expectedFee =
      10 * ESTIMATE_ASSUMPTIONS.searchesPerGroundedCall * perSearch;
    expect(grounded.askUsd - parametric.askUsd).toBeCloseTo(expectedFee, 10);
  });

  it('adds no search fee to a grounded estimate for an engine that cannot search', () => {
    // claude-sonnet-5 has no perSearchUsd: under --grounded it is honestly
    // tagged parametric, so charging it a search fee would be fake precision.
    const parametric = estimateRun(10, ['claude-sonnet-5'], 'gpt-5.4');
    const grounded = estimateRun(10, ['claude-sonnet-5'], 'gpt-5.4', {
      ...ESTIMATE_ASSUMPTIONS,
      grounded: true,
    });
    expect(grounded.askUsd).toBeCloseTo(parametric.askUsd, 10);
  });

  // The global avgOutputTokens (500) is ~5x wrong for a thinking model:
  // Gemini averaged 2584 live, because thinking tokens bill as output. The
  // probe patched this at ONE call site inside askAll, leaving every other
  // estimator - including the confirm gate the user actually reads - quoting
  // roughly a fifth of what the run bills. Pricing carries the per-model
  // assumption so all of them agree.
  it('uses a per-model output-token assumption where one is known', () => {
    const pricing = MODEL_PRICING.models['claude-sonnet-5']!;
    // Anthropic answers far shorter than the thinking models (measured ~700),
    // so it carries its own figure instead of the conservative global default.
    expect(pricing.avgOutputTokens).toBe(900);
    expect(pricing.avgOutputTokens).toBeLessThan(
      ESTIMATE_ASSUMPTIONS.avgOutputTokens,
    );

    const est = estimateRun(1, ['claude-sonnet-5'], 'gpt-5.4');
    const expected = costOfCall(
      pricing,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      900, // the model's own figure, NOT the 2600 global
    );
    expect(est.askUsd).toBeCloseTo(expected, 10);
  });

  // The global default is the fallback for an unmeasured model, and it must
  // err HIGH: a live low-cap run breached its cap by 47% because 500 predates
  // the thinking-model generation (real asks measured 2583 and 3356).
  // Under-reserving breaches the cap; over-reserving costs only parallelism,
  // because settle returns the excess as soon as a call completes.
  it('defaults to a conservative modern output-token figure', () => {
    expect(ESTIMATE_ASSUMPTIONS.avgOutputTokens).toBeGreaterThanOrEqual(2500);
  });

  it('falls back to the global assumption for a model with no per-model figure', () => {
    expect(MODEL_PRICING.models['gpt-5.4']?.avgOutputTokens).toBeUndefined();
    const est = estimateRun(1, ['gpt-5.4'], 'gpt-5.4');
    const expected = costOfCall(
      MODEL_PRICING.models['gpt-5.4']!,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      ESTIMATE_ASSUMPTIONS.avgOutputTokens,
    );
    expect(est.askUsd).toBeCloseTo(expected, 10);
  });

  it('assumes at least as many searches as a real call was observed to make', () => {
    // The one real captured grounded call issued 3 searches. The assumption
    // must not sit below observed reality: with reserve-and-settle an
    // over-estimate settles back down, an under-estimate breaches the cap.
    expect(ESTIMATE_ASSUMPTIONS.searchesPerGroundedCall).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('scales linearly with prompt count', () => {
    const a = estimateRun(10, ['gpt-4o-mini'], 'gpt-4o-mini');
    const b = estimateRun(20, ['gpt-4o-mini'], 'gpt-4o-mini');
    expect(b.totalUsd).toBeCloseTo(a.totalUsd * 2, 10);
  });

  it('throws UnknownModelError for a model not in the table', () => {
    expect(() => estimateRun(1, ['no-such-model'], 'gpt-4o-mini')).toThrow(
      UnknownModelError,
    );
  });
});

describe('CostGuard', () => {
  // `authorize` reserves, so it must be closed out with `settle` - pairing it
  // with bare `record` leaves the hold outstanding and shrinks the budget.
  it('authorizes spends under the cap and accumulates actuals', () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    expect(guard.authorize(0.4)).toBe(true);
    guard.settle(0.4, 0.4);
    expect(guard.authorize(0.5)).toBe(true);
    guard.settle(0.5, 0.5);
    expect(guard.spentUsd).toBeCloseTo(0.9, 10);
    expect(guard.costCapped).toBe(false);
  });

  it('refuses a spend that would exceed the cap, marks capped, and never throws', () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    guard.record(0.8);
    let allowed: boolean;
    expect(() => {
      allowed = guard.authorize(0.5); // 0.8 + 0.5 > 1
    }).not.toThrow();
    expect(allowed!).toBe(false);
    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBeCloseTo(0.8, 10); // refused spend not recorded
  });

  // A run must be able to report what it SPENT, and the guard is the only
  // thing that sees every spender: summing answers misses discovery,
  // query-gen, and the scoring judge entirely.
  it('reports spend broken down by phase', () => {
    const guard = new CostGuard();
    guard.record(0.02, 'setup');
    guard.record(0.5, 'main');
    expect(guard.spendBreakdown).toEqual({
      setupUsd: 0.02,
      mainUsd: 0.5,
      totalUsd: 0.52,
    });
  });

  it('reports a zero breakdown for a guard that never spent', () => {
    expect(new CostGuard().spendBreakdown).toEqual({
      setupUsd: 0,
      mainUsd: 0,
      totalUsd: 0,
    });
  });

  it('with no cap, authorizes everything', () => {
    const guard = new CostGuard();
    expect(guard.authorize(1000)).toBe(true);
    expect(guard.costCapped).toBe(false);
  });

  it('enforces a separate setup budget before the main cap', () => {
    const guard = new CostGuard({ maxCostUsd: 1, maxSetupCostUsd: 0.05 });
    expect(guard.authorize(0.04, 'setup')).toBe(true);
    guard.record(0.04, 'setup');
    // Next setup spend would exceed the setup cap even though total is fine.
    expect(guard.authorize(0.02, 'setup')).toBe(false);
    expect(guard.costCapped).toBe(true);
  });
  // Found live 2026-07-20: `--max-cost 0.20` spent $0.3481, a 74% breach.
  // `authorize` only COMPARED against recorded spend, and recording happens
  // after a call returns - so with concurrent calls in flight, every one of
  // them was authorized against a spend figure that excluded all the others.
  // Authorizing must therefore RESERVE the projected cost (hard rule #5:
  // respect --max-cost).
  it('reserves authorized spend so concurrent calls cannot double-spend headroom', () => {
    const guard = new CostGuard({ maxCostUsd: 0.1 });
    // Three calls authorized before any has completed. 3 x 0.04 = 0.12 > 0.10.
    expect(guard.authorize(0.04)).toBe(true);
    expect(guard.authorize(0.04)).toBe(true);
    expect(guard.authorize(0.04)).toBe(false);
    expect(guard.costCapped).toBe(true);
  });

  // A reservation is a hold, not a charge: settling replaces it with the real
  // cost. If the actual comes in UNDER the estimate, that headroom must return
  // to the budget or a long run would strangle itself.
  it('settles a reservation with the actual cost and frees the difference', () => {
    const guard = new CostGuard({ maxCostUsd: 0.1 });
    expect(guard.authorize(0.04)).toBe(true);
    guard.settle(0.04, 0.01); // reserved 4c, really cost 1c
    expect(guard.spentUsd).toBeCloseTo(0.01, 10);
    // 9c of headroom is genuinely free again.
    expect(guard.authorize(0.08)).toBe(true);
  });

  // A call that throws never records a cost. Without an explicit release the
  // reservation leaks and permanently shrinks the budget, so a run with a few
  // failures would cap out early for no reason.
  it('releases a reservation when the call failed and cost nothing', () => {
    const guard = new CostGuard({ maxCostUsd: 0.1 });
    expect(guard.authorize(0.09)).toBe(true);
    guard.settle(0.09, 0); // request failed
    expect(guard.spentUsd).toBe(0);
    expect(guard.authorize(0.09)).toBe(true);
  });

  // Over-spend must still be counted honestly: if the actual exceeds what was
  // reserved (a thinking model emitting far more tokens than assumed), the
  // guard books the real figure, not the estimate.
  it('books an actual that overruns its reservation', () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    expect(guard.authorize(0.01)).toBe(true);
    guard.settle(0.01, 0.05);
    expect(guard.spentUsd).toBeCloseTo(0.05, 10);
  });

  // `authorize` was the ONLY thing that could set `capped`, so a call whose
  // real cost overshot its reservation carried the run past --max-cost with no
  // flag at all: the envelope reported a clean full-confidence run and the
  // footer printed a total above the cap the user set. The money is already
  // spent by then and cannot be refused - but it MUST be reported (rule #6).
  it('marks costCapped when a settled actual pushes spend past the cap', () => {
    const guard = new CostGuard({ maxCostUsd: 0.2 });
    expect(guard.authorize(0.03)).toBe(true);
    guard.settle(0.03, 0.24); // a thinking-heavy grounded call overshoots
    expect(guard.spentUsd).toBeCloseTo(0.24, 10);
    expect(guard.costCapped).toBe(true);
  });

  it('marks costCapped when a settled actual overshoots the SETUP cap', () => {
    const guard = new CostGuard({ maxCostUsd: 10, maxSetupCostUsd: 0.05 });
    expect(guard.authorize(0.02, 'setup')).toBe(true);
    guard.settle(0.02, 0.09, 'setup');
    expect(guard.costCapped).toBe(true);
  });

  it('does not mark costCapped when a settled actual stays within the cap', () => {
    const guard = new CostGuard({ maxCostUsd: 0.2 });
    expect(guard.authorize(0.03)).toBe(true);
    guard.settle(0.03, 0.05);
    expect(guard.costCapped).toBe(false);
  });

  it('leaves an uncapped guard alone however much it settles', () => {
    const guard = new CostGuard();
    expect(guard.authorize(1)).toBe(true);
    guard.settle(1, 1000);
    expect(guard.costCapped).toBe(false);
  });
});
