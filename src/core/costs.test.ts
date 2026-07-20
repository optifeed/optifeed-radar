import { describe, expect, it } from 'vitest';
import {
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
});
