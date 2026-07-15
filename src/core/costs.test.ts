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
  it('authorizes spends under the cap and accumulates actuals', () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    expect(guard.authorize(0.4)).toBe(true);
    guard.record(0.4);
    expect(guard.authorize(0.5)).toBe(true);
    guard.record(0.5);
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
});
