import { describe, expect, it } from 'vitest';
import { CostGuard } from './costs.js';
import type { JudgeClient } from './types.js';

/**
 * A mock JudgeClient - the shape M4/M5 depend on (they never import M6). Proves
 * the interface is implementable and composes with the cost guard's setup phase.
 */
function mockJudge(model: string, costUsd: number): JudgeClient {
  return {
    model,
    async complete(prompt) {
      return { text: `answer to: ${prompt}`, costUsd, model };
    },
  };
}

describe('JudgeClient contract', () => {
  it('round-trips a call and records spend against the setup budget', async () => {
    const judge = mockJudge('gpt-4o-mini', 0.01);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05, maxCostUsd: 1 });

    expect(guard.authorize(0.01, 'setup')).toBe(true);
    const res = await judge.complete('who competes with acme?');
    guard.record(res.costUsd, 'setup');

    expect(res.text).toBe('answer to: who competes with acme?');
    expect(res.model).toBe('gpt-4o-mini');
    expect(guard.spentUsd).toBeCloseTo(0.01, 10);
    expect(guard.costCapped).toBe(false);
  });

  it('lets the guard stop a judge call that would blow the setup budget', async () => {
    const judge = mockJudge('gpt-4o-mini', 0.1);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    // Over the setup cap: caller must NOT make the call.
    const allowed = guard.authorize(0.1, 'setup');
    expect(allowed).toBe(false);
    expect(guard.costCapped).toBe(true);
    // Nothing spent because the guarded call never ran.
    expect(guard.spentUsd).toBe(0);
    void judge; // the point is we did not call it
  });
});
