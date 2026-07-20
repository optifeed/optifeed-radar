import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGE_MODELS } from '../config.js';
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

  // A --grounded run must not MISLABEL an engine that cannot ground. Anthropic
  // has no web-search mode here (`supportsGrounded` unset and native kind
  // parametric), so a grounded request falls back to its native kind: the answer
  // is honestly tagged `parametric` - renderers separate the two and scoring
  // weights grounded higher, so a parametric-answer-labelled-grounded would be
  // fake precision (rule #6).
  it('does not label a non-grounding engine grounded when grounded is requested', async () => {
    const { fn } = fakePost({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const answer = await createAdapter(anthropicSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q', { mode: 'grounded' });
    expect(answer.kind).toBe('parametric');
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

  // Fanout capture (Profound study): engines rewrite the prompt heavily before
  // searching, so "what the AI actually searched for" is evidence no free tool
  // exposes. OpenAI surfaces it on web_search_call.action.queries (verified live
  // 2026-07-17). Record it when present; never fabricate it (rule #6).
  it('captures fanoutQueries from a grounded web_search_call', async () => {
    const { fn } = fakePost(groundedFixture);
    const answer = await createAdapter(openaiSpec, {
      httpPost: fn,
      apiKey: 'sk-test',
      now: () => FIXED,
    }).ask('best product feed tools?', { mode: 'grounded' });
    expect(answer.fanoutQueries).toEqual([
      'best product feed management tools 2026',
    ]);
  });

  // Absent metadata = field omitted, never fabricated. A parametric chat answer
  // ran no searches, so it carries no fanoutQueries at all.
  it('omits fanoutQueries on a parametric answer', async () => {
    const { fn } = fakePost({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const answer = await createAdapter(openaiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('q');
    expect(answer.fanoutQueries).toBeUndefined();
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

  // ---------------------------------------------------------------------------
  // Live verification 2026-07-20 (M17 smoke debt): the anthropic/gemini/perplexity
  // specs were hand-written and had never met a real payload. These fixtures were
  // captured live against the real APIs.
  // ---------------------------------------------------------------------------

  function realFixture(name: string): unknown {
    return JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../../test/fixtures/engines/${name}`, import.meta.url),
        ),
        'utf8',
      ),
    ) as unknown;
  }

  const geminiReal = realFixture('gemini-real.json');
  const perplexityReal = realFixture('perplexity-real.json');
  const anthropicReal = realFixture('anthropic-real.json');

  // The Anthropic spec had never met a real payload either. It parses correctly:
  // content[] text blocks, usage.input_tokens/output_tokens, and an echoed model
  // id. Note the echo is DATED (claude-haiku-4-5-20251001) while the configured
  // id is not - exactly the lesson #2 case the adapter handles by pricing from
  // the CONFIGURED model, which is the key guaranteed to be in MODEL_PRICING.
  it('parses a REAL Anthropic messages payload', async () => {
    const { fn } = fakePost(anthropicReal);
    const answer = await createAdapter(anthropicSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('best acoustic pianos 2026?');

    expect(answer.kind).toBe('parametric');
    expect(answer.text.length).toBeGreaterThan(0);
    expect(answer.tokens).toEqual({ input: 28, output: 239 });
    expect(answer.model).toBe('claude-haiku-4-5-20251001');
    // Priced from the configured id despite the dated echo.
    expect(answer.costUsd).toBeGreaterThan(0);
  });

  // `gemini-2.5-flash` returned HTTP 404 "no longer available to new users" on
  // 2026-07-20 - the default was not merely stale (as gpt-4o-mini was), it was
  // DEAD, so every Gemini run failed. `gemini-flash-latest` is Google's alias for
  // the current Flash generation (resolved live to gemini-3.5-flash), chosen for
  // the same reason as OpenAI's `-chat-latest`: it tracks what the Gemini app
  // actually serves and cannot 404 out from under us.
  it('asks Gemini with a model that still exists, and prices it', () => {
    const { fn } = fakePost({});
    const adapter = createAdapter(geminiSpec, { httpPost: fn, apiKey: 'k' });
    expect(adapter.model).toBe('gemini-flash-latest');
    expect(MODEL_PRICING.models[adapter.model]).toBeDefined();
  });

  // Gemini bills thinking tokens at the OUTPUT rate ("Output: $9.00 per 1M
  // tokens (includes thinking tokens)", official pricing sheet 2026-07-20), but
  // reports them in a SEPARATE field. Counting only `candidatesTokenCount` under-
  // reported this real call by 1274 tokens - the run spends money it never shows
  // (hard rule #5). totalTokenCount (3092) = prompt 21 + answer 1797 + thoughts
  // 1274, which is the arithmetic proof that thoughts are billable output.
  it('counts Gemini thinking tokens as billed output (REAL payload)', async () => {
    const { fn } = fakePost(geminiReal);
    const answer = await createAdapter(geminiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('best acoustic pianos 2026?');

    expect(answer.tokens).toEqual({ input: 21, output: 1797 + 1274 });
    expect(answer.model).toBe('gemini-3.5-flash');
    expect(answer.text).toContain('acoustic pianos');
    expect(answer.costUsd).toBeGreaterThan(0);
  });

  // A thinking model can emit reasoning parts alongside the answer. Joining every
  // part's text would splice private reasoning into the measured answer, which
  // then gets scored and shown to the user as what the engine "said".
  it('excludes Gemini thought parts from the answer text', async () => {
    const { fn } = fakePost({
      candidates: [
        {
          content: {
            parts: [
              { text: 'I should mention Yamaha here.', thought: true },
              { text: 'Yamaha makes excellent pianos.' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      modelVersion: 'gemini-3.5-flash',
    });
    const answer = await createAdapter(geminiSpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('pianos?');

    expect(answer.text).toBe('Yamaha makes excellent pianos.');
    expect(answer.text).not.toContain('I should mention');
  });

  // Verified live 2026-07-20: with maxOutputTokens 60 (the scoring judge's
  // budget), thinking consumed 55 of the 60 and the answer came back as a single
  // stray character - finishReason MAX_TOKENS. `thinkingBudget: 0` returned a
  // clean "Yes" on the same call. Gemini budgets thinking and answer TOGETHER, so
  // any caller-supplied cap must exclude thinking or the answer is starved. The
  // ask path sends no cap and keeps thinking on (that is what a real user gets).
  it('disables Gemini thinking when the caller caps tokens', async () => {
    const { fn, calls } = fakePost(geminiReal);
    const adapter = createAdapter(geminiSpec, { httpPost: fn, apiKey: 'k' });

    await adapter.ask('judge this', { maxTokens: 60 });
    const capped = JSON.parse(calls[0]!.body) as {
      generationConfig?: { thinkingConfig?: { thinkingBudget?: number } };
    };
    expect(capped.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);

    await adapter.ask('answer this');
    const uncapped = JSON.parse(calls[1]!.body) as {
      generationConfig?: { thinkingConfig?: unknown };
    };
    expect(uncapped.generationConfig?.thinkingConfig).toBeUndefined();
  });

  // Perplexity's hand-written spec turned out to be CORRECT: `citations` really
  // is top-level on the raw body (unlike OpenAI, where it was an SDK-only
  // convenience). Pinning that against a real payload so it stays true.
  it('parses a REAL Perplexity sonar payload', async () => {
    const { fn } = fakePost(perplexityReal);
    const answer = await createAdapter(perplexitySpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('best acoustic pianos 2026?');

    expect(answer.kind).toBe('grounded');
    expect(answer.text.length).toBeGreaterThan(0);
    expect(answer.citations?.length).toBeGreaterThan(0);
    expect(answer.citations?.[0]).toMatch(/^https?:\/\//);
    expect(answer.tokens).toEqual({ input: 20, output: 816 });
    expect(answer.model).toBe('sonar');
  });

  // The dead `gemini-2.5-flash` id was hardcoded in TWO places - the provider
  // spec AND the judge defaults - so fixing only the spec left every Gemini-
  // judged run failing on its setup calls (caught live 2026-07-20, not by tests).
  // Pin both lists against the pricing table so a model id can never drift into
  // an unpriced (silently $0, lesson #2) or forgotten second home again.
  it('prices every default engine model and every default judge model', () => {
    for (const spec of [
      openaiSpec,
      anthropicSpec,
      geminiSpec,
      perplexitySpec,
    ]) {
      expect(
        MODEL_PRICING.models[spec.defaultModel],
        `${spec.id} spec defaultModel "${spec.defaultModel}" is not priced`,
      ).toBeDefined();
    }
    for (const [engine, model] of Object.entries(DEFAULT_JUDGE_MODELS)) {
      expect(
        MODEL_PRICING.models[model],
        `${engine} judge model "${model}" is not priced`,
      ).toBeDefined();
    }
  });

  // Perplexity charges a flat per-request search fee ON TOP of tokens. The real
  // payload self-reports it: request_cost $0.005 vs token cost $0.00084, so
  // pricing by tokens alone under-reported this call by 7x. A 20-prompt run hides
  // ~$0.10 of real spend (hard rule #5). The API hands us the true figure, so the
  // test asserts against Perplexity's OWN total_cost.
  it('includes the Perplexity per-request search fee in cost', async () => {
    const { fn } = fakePost(perplexityReal);
    const answer = await createAdapter(perplexitySpec, {
      httpPost: fn,
      apiKey: 'k',
      now: () => FIXED,
    }).ask('best acoustic pianos 2026?');

    // Perplexity's own accounting for this exact call.
    expect(answer.costUsd).toBeCloseTo(0.00584, 5);
  });
});
