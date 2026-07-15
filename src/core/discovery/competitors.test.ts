import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { JudgeClient } from '../types.js';
import { discoverCompetitors } from './competitors.js';

/** A judge that records the prompt it saw and returns a canned answer. */
function recordingJudge(
  text: string,
  costUsd = 0.001,
  model = 'gpt-4o-mini',
): JudgeClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model,
    async complete(prompt) {
      prompts.push(prompt);
      return { text, costUsd, model };
    },
  };
}

describe('discoverCompetitors', () => {
  it('parses a JSON array of names and bills the setup budget', async () => {
    const judge = recordingJudge('["Estes", "Quest Aerospace"]', 0.002);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme Rockets', category: 'Model rockets' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Estes', 'Quest Aerospace']);
    expect(guard.spentUsd).toBeCloseTo(0.002, 10);
    expect(judge.prompts[0]).toContain('Acme Rockets');
  });

  it('parses a numbered/bulleted list when the model does not return JSON', async () => {
    const judge = recordingJudge('1. Estes\n2. Quest\n- Apogee Components\n');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Estes', 'Quest', 'Apogee Components']);
  });

  it('skips the call and never spends when it would exceed the setup cap', async () => {
    const judge = recordingJudge('["Estes"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.0000001 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual([]);
    expect(result.skipped).toBeDefined();
    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBe(0); // the guarded call never ran
    expect(judge.prompts).toEqual([]);
  });

  it('degrades to no competitors (never throws) when the judge errors', async () => {
    const judge: JudgeClient = {
      model: 'gpt-4o-mini',
      complete() {
        return Promise.reject(new Error('502 upstream'));
      },
    };
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual([]);
    expect(result.skipped).toContain('502');
    expect(guard.spentUsd).toBe(0);
  });
});
