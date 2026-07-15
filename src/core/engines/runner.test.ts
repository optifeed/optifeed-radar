import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { EngineAnswer, EngineId } from '../types.js';
import type { EngineAdapter } from './adapter.js';
import { askAll } from './runner.js';

function fakeAdapter(
  id: EngineId,
  opts: {
    available?: boolean;
    costUsd?: number;
    failOn?: (prompt: string) => boolean;
  } = {},
): EngineAdapter {
  return {
    id,
    kind: 'parametric',
    model: `${id}-model`,
    available: () => opts.available ?? true,
    async ask(prompt): Promise<EngineAnswer> {
      if (opts.failOn?.(prompt)) throw new Error(`${id} boom`);
      return {
        engine: id,
        kind: 'parametric',
        prompt,
        text: `${id}:${prompt}`,
        model: `${id}-model`,
        costUsd: opts.costUsd ?? 0.01,
        ts: 't',
      };
    },
  };
}

describe('askAll', () => {
  it('builds the full answer matrix across adapters and prompts', async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [fakeAdapter('openai'), fakeAdapter('anthropic')],
    );
    expect(result.answers).toHaveLength(4);
    expect(result.skippedEngines).toEqual([]);
  });

  it('skips unavailable adapters with a reason', async () => {
    const result = await askAll(
      ['p1'],
      [fakeAdapter('openai'), fakeAdapter('gemini', { available: false })],
    );
    expect(result.answers.map((a) => a.engine)).toEqual(['openai']);
    expect(result.skippedEngines).toContainEqual({
      engine: 'gemini',
      reason: expect.stringContaining('key'),
    });
  });

  it("a single adapter's total failure never kills the run", async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [
        fakeAdapter('openai'),
        fakeAdapter('perplexity', { failOn: () => true }),
      ],
    );
    expect(result.answers.map((a) => a.engine).sort()).toEqual([
      'openai',
      'openai',
    ]);
    expect(result.skippedEngines[0]?.engine).toBe('perplexity');
  });

  it('keeps partial successes when only some prompts fail', async () => {
    const result = await askAll(
      ['good', 'bad'],
      [fakeAdapter('openai', { failOn: (p) => p === 'bad' })],
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.prompt).toBe('good');
    expect(result.skippedEngines).toEqual([]);
  });

  it('records per-call cost into the CostGuard', async () => {
    const guard = new CostGuard();
    await askAll(['p1', 'p2'], [fakeAdapter('openai', { costUsd: 0.02 })], {
      guard,
    });
    expect(guard.spentUsd).toBeCloseTo(0.04, 10);
  });
});
