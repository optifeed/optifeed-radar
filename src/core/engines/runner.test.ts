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

  it('ticks onAnswered exactly once per individual call (ok and error paths)', async () => {
    let ticks = 0;
    await askAll(
      ['good', 'bad'],
      [
        fakeAdapter('openai'),
        fakeAdapter('perplexity', { failOn: (p) => p === 'bad' }),
      ],
      { onAnswered: () => (ticks += 1) },
    );
    // 2 prompts x 2 adapters, each settles once (one of them errors).
    expect(ticks).toBe(4);
  });

  it('ticks onAnswered once per call when the cost cap stops asking', async () => {
    const guard = new CostGuard({ maxCostUsd: 0 }); // caps immediately
    let ticks = 0;
    await askAll(['p1', 'p2'], [fakeAdapter('openai', { costUsd: 0.02 })], {
      guard,
      onAnswered: () => (ticks += 1),
    });
    // Both prompts settle (as capped) and each ticks exactly once - no double count.
    expect(ticks).toBe(2);
  });

  it('records per-call cost into the CostGuard', async () => {
    const guard = new CostGuard();
    await askAll(['p1', 'p2'], [fakeAdapter('openai', { costUsd: 0.02 })], {
      guard,
    });
    expect(guard.spentUsd).toBeCloseTo(0.04, 10);
  });

  // Found live 2026-07-20: a free-tier Gemini key rate-limited 7 of 8 calls.
  // The engine answered ONCE, was scored on that single sample, sat in the
  // report next to engines with 8, and the run carried NO honesty flag - every
  // derived artifact (diff, --fail-under, HTML) read it as complete. The errors
  // were computed and then dropped on the floor (lesson #7, fetch-and-discard).
  // Partial failure is a distinct signal from total failure, so it gets its own
  // flag rather than being folded into `skippedEngines` (the engine was NOT
  // skipped - it produced real, scoreable answers).
  it('reports an engine that answered only some prompts as partial', async () => {
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4'],
      [fakeAdapter('gemini', { failOn: (p) => p !== 'p1' })],
    );

    expect(result.answers).toHaveLength(1);
    // Not skipped - it answered.
    expect(result.skippedEngines).toEqual([]);
    expect(result.partialEngines).toHaveLength(1);
    expect(result.partialEngines[0]).toMatchObject({
      engine: 'gemini',
      attempted: 4,
      answered: 1,
    });
    expect(result.partialEngines[0]!.reason).toContain('boom');
  });

  // The boundary between the two signals must stay exact: a TOTAL failure is
  // skipped (already correct, verified live against a quota-exhausted Gemini),
  // and must NOT also be double-reported as partial.
  it('keeps a totally-failed engine skipped, not partial', async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [fakeAdapter('gemini', { failOn: () => true })],
    );
    expect(result.skippedEngines).toHaveLength(1);
    expect(result.partialEngines).toEqual([]);
  });

  it('reports no partial engines when every call succeeds', async () => {
    const result = await askAll(['p1', 'p2'], [fakeAdapter('openai')]);
    expect(result.partialEngines).toEqual([]);
  });
});
