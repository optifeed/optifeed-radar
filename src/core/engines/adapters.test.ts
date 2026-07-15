import { describe, expect, it } from 'vitest';
import { costOfCall, MODEL_PRICING } from '../costs.js';
import { createAdapter } from './adapter.js';
import { anthropicSpec } from './anthropic.js';
import { geminiSpec } from './gemini.js';
import { openaiSpec } from './openai.js';
import { perplexitySpec } from './perplexity.js';
import type { HttpPost, HttpJsonResponse } from './http.js';

const FIXED = '2026-07-15T00:00:00.000Z';

function jsonResponse(body: unknown): HttpJsonResponse {
  return { status: 200, json: async () => body, text: async () => '' };
}

/** A fake httpPost returning a canned body and recording the last call. */
function fakePost(body: unknown) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const fn: HttpPost = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return jsonResponse(body);
  };
  return { fn, calls };
}

describe('createAdapter', () => {
  it('reports availability from the presence of an API key', () => {
    const { fn } = fakePost({});
    expect(
      createAdapter(openaiSpec, { httpPost: fn, apiKey: 'k' }).available(),
    ).toBe(true);
    expect(createAdapter(openaiSpec, { httpPost: fn }).available()).toBe(false);
  });

  it('throws when asked without a key', async () => {
    const { fn } = fakePost({});
    const a = createAdapter(openaiSpec, { httpPost: fn });
    await expect(a.ask('q')).rejects.toThrow();
  });

  it('parses an OpenAI chat answer and computes cost from usage', async () => {
    const { fn, calls } = fakePost({
      choices: [{ message: { content: 'Acme is a solid pick.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    const adapter = createAdapter(openaiSpec, {
      httpPost: fn,
      apiKey: 'sk-test',
      now: () => FIXED,
    });
    const answer = await adapter.ask('best espresso machine?');

    expect(answer).toMatchObject({
      engine: 'openai',
      kind: 'parametric',
      text: 'Acme is a solid pick.',
      model: 'gpt-4o-mini',
      tokens: { input: 10, output: 20 },
      ts: FIXED,
    });
    const expected = costOfCall(MODEL_PRICING.models['gpt-4o-mini']!, 10, 20);
    expect(answer.costUsd).toBeCloseTo(expected, 12);
    // Request shape: chat endpoint + bearer auth.
    expect(calls[0]!.url).toContain('/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-test');
  });

  it('parses an Anthropic answer', async () => {
    const { fn } = fakePost({
      content: [{ type: 'text', text: 'Anthropic says hi.' }],
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    const answer = await createAdapter(anthropicSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q');
    expect(answer.text).toBe('Anthropic says hi.');
    expect(answer.tokens).toEqual({ input: 5, output: 7 });
  });

  it('parses a Gemini answer', async () => {
    const { fn } = fakePost({
      candidates: [{ content: { parts: [{ text: 'Gemini answer.' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    });
    const answer = await createAdapter(geminiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q');
    expect(answer.text).toBe('Gemini answer.');
    expect(answer.tokens).toEqual({ input: 3, output: 4 });
  });

  it('parses a Perplexity answer with citations and reports grounded kind', async () => {
    const { fn } = fakePost({
      choices: [{ message: { content: 'Per Perplexity.' } }],
      citations: ['https://review.example/a', 'https://review.example/b'],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    const answer = await createAdapter(perplexitySpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q');
    expect(answer.kind).toBe('grounded');
    expect(answer.text).toBe('Per Perplexity.');
    expect(answer.citations).toEqual([
      'https://review.example/a',
      'https://review.example/b',
    ]);
  });
});
