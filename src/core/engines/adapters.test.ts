import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  const fn: HttpPost = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return jsonResponse(body);
  };
  return { fn, calls };
}

describe('createAdapter', () => {
  // The product's claim is "does the AI your buyers use recommend you?", so the
  // engine we ASK must be the model those buyers actually get. `gpt-4o-mini` was
  // both the wrong generation (gpt-4o is legacy; ChatGPT serves GPT-5.x) and the
  // wrong tier (nobody chats with mini). `-chat-latest` is OpenAI's alias for
  // whatever ChatGPT currently serves - verified live 2026-07-17.
  it('asks OpenAI with the model ChatGPT actually serves, and prices it', () => {
    const { fn } = fakePost({});
    const adapter = createAdapter(openaiSpec, { httpPost: fn, apiKey: 'k' });
    expect(adapter.model).toBe('gpt-5.3-chat-latest');
    expect(MODEL_PRICING.models[adapter.model]).toBeDefined();
  });

  // Verified live 2026-07-17 against all four ids: GPT-5 models REJECT
  // `max_tokens` with unsupported_parameter and require `max_completion_tokens`;
  // the legacy gpt-4o pair accepts BOTH. So the new name is used unconditionally
  // - no per-model branching. Sending `max_tokens` to gpt-5.3-chat-latest is an
  // HTTP 400, which the guard surfaces as a skipped engine (a whole run of no
  // answers).
  it('sends max_completion_tokens (GPT-5 rejects max_tokens)', async () => {
    const { fn, calls } = fakePost({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await createAdapter(openaiSpec, { httpPost: fn, apiKey: 'k' }).ask('q', {
      maxTokens: 256,
    });
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
  });

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
      model: 'gpt-4o-mini', // pinned: this test is about parsing, not the default
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
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
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

  // Lesson #1: parse the shape production ACTUALLY returns. This fixture is a
  // real /v1/responses + web_search payload captured live on 2026-07-17 (text
  // and annotations trimmed for review; structure untouched). The previous
  // grounded parser read `output_text`/`citations` off the top level - both are
  // SDK conveniences that DO NOT exist on the raw HTTP response, so a real
  // grounded call billed ~8k input tokens and returned an empty answer with no
  // citations, silently.
  const groundedFixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../test/fixtures/engines/openai-grounded-real.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as unknown;

  it('parses a REAL OpenAI grounded (Responses + web_search) payload', async () => {
    const { fn, calls } = fakePost(groundedFixture);
    const answer = await createAdapter(openaiSpec, {
      httpPost: fn,
      apiKey: 'sk-test',
      now: () => FIXED,
    }).ask('best product feed tools?', { mode: 'grounded' });

    expect(answer.kind).toBe('grounded');
    // The text lives at output[] -> message -> content[] -> output_text.text
    expect(answer.text).toContain('product feed management tools');
    // Citations come from that content's url_citation annotations.
    expect(answer.citations?.length).toBeGreaterThan(0);
    expect(answer.citations?.[0]).toMatch(/^https?:\/\//);
    // Usage keys on this endpoint are input_tokens/output_tokens.
    expect(answer.tokens).toEqual({ input: 8174, output: 582 });
    expect(answer.costUsd).toBeGreaterThan(0);
    // Providers echo a DATED model id; cost must still price (lesson #2).
    expect(answer.model).toBe('gpt-4o-mini-2024-07-18');
    expect(calls[0]!.url).toContain('/responses');
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
