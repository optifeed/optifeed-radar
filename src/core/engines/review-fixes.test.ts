import { describe, expect, it } from 'vitest';
import {
  CostGuard,
  ESTIMATE_ASSUMPTIONS,
  MODEL_PRICING,
  assumedOutputTokens,
  costOfCall,
} from '../costs.js';
import type { EngineAnswer, EngineId } from '../types.js';
import { type EngineAdapter, createAdapter } from './adapter.js';
import { geminiSpec } from './gemini.js';
import { HttpError, type HttpPost, postJsonWithRetry } from './http.js';
import { openaiSpec } from './openai.js';
import { UNMEASURED_CALL_MARGIN, askAll } from './runner.js';

const FIXED = '2026-07-15T00:00:00.000Z';

function fakePost(body: unknown) {
  const calls: { url: string; body: string }[] = [];
  const fn: HttpPost = async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, json: async () => body, text: async () => '' };
  };
  return { fn, calls };
}

function fakeAdapter(
  id: EngineId,
  opts: { model: string; costUsd: number },
): EngineAdapter {
  return {
    id,
    kind: 'parametric',
    model: opts.model,
    available: () => true,
    async ask(prompt): Promise<EngineAnswer> {
      return {
        engine: id,
        kind: 'parametric',
        prompt,
        text: 't',
        model: opts.model,
        costUsd: opts.costUsd,
        ts: FIXED,
      };
    },
  };
}

// Finding 1
describe('adapter cost pricing', () => {
  it('prices by the configured model even when the API echoes a dated id', async () => {
    const { fn } = fakePost({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      model: 'gpt-4o-mini-2024-07-18', // dated snapshot id, absent from MODEL_PRICING
    });
    const answer = await createAdapter(openaiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
      // Pin the model: this asserts the CONFIGURED-vs-echoed principle, so it
      // must not silently re-target whenever the default model changes.
      model: 'gpt-4o-mini',
    }).ask('q');

    expect(answer.model).toBe('gpt-4o-mini-2024-07-18'); // reports the actual id
    const expected = costOfCall(MODEL_PRICING.models['gpt-4o-mini']!, 10, 20);
    expect(answer.costUsd).toBeCloseTo(expected, 12); // priced, not $0
  });
});

// Finding 2
describe('askAll cost cap enforcement', () => {
  it('stops asking once the cap would be exceeded and marks the run capped', async () => {
    // The cap is DERIVED from the same estimate the runner reserves against,
    // rather than hardcoded: a hardcoded figure silently re-targets whenever
    // an assumption moves (raising avgOutputTokens 500 -> 2600 turned this
    // test's "allows one call" budget into "allows none"). Room for exactly
    // one reservation, and not enough left for a second once the first call's
    // real cost is booked.
    const pricing = MODEL_PRICING.models['gpt-4o-mini']!;
    const perCall = costOfCall(
      pricing,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      assumedOutputTokens(pricing),
    );
    // Real cost equal to the estimate, so once the first call is booked a
    // second reservation cannot fit. The budget covers exactly the margined
    // first reservation and nothing beyond it.
    const actual = perCall;
    const guard = new CostGuard({
      maxCostUsd: perCall * UNMEASURED_CALL_MARGIN + perCall * 0.1,
    });
    const adapter = fakeAdapter('openai', {
      model: 'gpt-4o-mini',
      costUsd: actual,
    });

    const result = await askAll(['p1', 'p2', 'p3'], [adapter], {
      guard,
      concurrency: 1,
    });

    expect(result.answers).toHaveLength(1);
    expect(guard.costCapped).toBe(true);
  });
});

// Finding 5
describe('postJsonWithRetry non-JSON 2xx', () => {
  it('wraps a non-JSON 200 body in HttpError instead of a raw parse error', async () => {
    const post: HttpPost = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => '<html>captive portal</html>',
    });
    await expect(
      postJsonWithRetry(
        post,
        'https://x',
        { headers: {}, body: '{}' },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

// Finding 6
describe('gemini maxTokens', () => {
  it('maps maxTokens to generationConfig.maxOutputTokens', async () => {
    const { fn, calls } = fakePost({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
    });
    await createAdapter(geminiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q', { maxTokens: 256 });
    const body = JSON.parse(calls[0]!.body) as {
      generationConfig?: { maxOutputTokens?: number };
    };
    expect(body.generationConfig?.maxOutputTokens).toBe(256);
  });
});
