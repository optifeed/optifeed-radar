/**
 * Gemini adapter (M6): parametric generateContent, with search grounding added
 * when `mode` is grounded. Grounding that is unavailable degrades to a plain
 * answer (the runner surfaces the degrade), never an error.
 */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

/** A bare hostname (`feedon.ai`), as opposed to a prose page title. */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The citation URL for one grounding chunk.
 *
 * Gemini returns `web.uri` as an opaque Google REDIRECT
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) and puts the
 * real publisher in `web.title`. Scoring derives cited domains with
 * `new URL(u).hostname`, so using the uri collapsed every citation in a run to
 * Google's own infrastructure domain and the sources table showed that instead
 * of the publishers (verified live 2026-07-20: 16 citations, 1 reported
 * domain). Those signed redirects also expire, so persisting them rots the
 * evidence. Prefer the title when it really is a hostname; otherwise keep the
 * uri - a working opaque link beats a fabricated one.
 */
function citationUrl(web: {
  uri?: string;
  title?: string;
}): string | undefined {
  const title = web.title?.trim();
  if (title && HOSTNAME.test(title)) return `https://${title}`;
  return web.uri;
}

interface GenerateShape {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      /** The rewritten queries Gemini actually searched (fanout evidence). */
      webSearchQueries?: string[];
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Thinking tokens. Billed at the OUTPUT rate but reported separately. */
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export const geminiSpec: ProviderSpec = {
  id: 'gemini',
  kind: 'parametric',
  // `gemini-2.5-flash` began returning HTTP 404 ("no longer available to new
  // users") - verified live 2026-07-20, so every Gemini run was failing. This
  // alias tracks the current Flash generation the Gemini app serves (resolved
  // live to gemini-3.5-flash), for the same reason OpenAI uses `-chat-latest`:
  // it cannot go 404 out from under us. It FLOATS, so re-verify price at M17.
  defaultModel: 'gemini-flash-latest',
  supportsGrounded: true,
  endpoint: (_mode, model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  buildRequest: ({ prompt, mode, apiKey, maxTokens }) => ({
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      ...(mode === 'grounded' ? { tools: [{ google_search: {} }] } : {}),
      // Gemini budgets thinking and answer from the SAME maxOutputTokens pool.
      // Verified live 2026-07-20: at the scoring judge's 60-token cap, thinking
      // ate 55 and the answer came back as one stray character (finishReason
      // MAX_TOKENS); with thinkingBudget 0 the same call answered cleanly. So a
      // caller-supplied cap must exclude thinking, or the answer is starved.
      // The ask path passes no cap and keeps thinking ON - that is what a real
      // Gemini user gets, and it is the answer we are measuring.
      ...(maxTokens
        ? {
            generationConfig: {
              maxOutputTokens: maxTokens,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }
        : {}),
    },
  }),
  parse: (json): ParsedResponse => {
    const r = json as GenerateShape;
    const candidate = r.candidates?.[0];
    // Thinking models can return reasoning parts alongside the answer; splicing
    // those into the text would score private reasoning as what the engine said.
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('');
    const citations = candidate?.groundingMetadata?.groundingChunks
      ?.map((c) => (c.web ? citationUrl(c.web) : undefined))
      .filter((u): u is string => Boolean(u));
    // What Gemini actually searched, where it exposes it. Recorded when present,
    // never fabricated (rule #6) - the OpenAI grounded path surfaces the same
    // evidence from web_search_call.action.queries.
    const fanoutQueries =
      candidate?.groundingMetadata?.webSearchQueries?.filter((q): q is string =>
        Boolean(q),
      );
    return {
      text,
      citations: citations && citations.length > 0 ? citations : undefined,
      fanoutQueries:
        fanoutQueries && fanoutQueries.length > 0 ? fanoutQueries : undefined,
      usage: r.usageMetadata
        ? {
            input: r.usageMetadata.promptTokenCount ?? 0,
            // Thinking tokens are billed at the output rate (official pricing
            // sheet: "Output ... (includes thinking tokens)"), so charging only
            // candidatesTokenCount silently under-reports spend - on a real
            // captured call, by 1274 tokens. Hard rule #5.
            output:
              (r.usageMetadata.candidatesTokenCount ?? 0) +
              (r.usageMetadata.thoughtsTokenCount ?? 0),
          }
        : undefined,
      model: r.modelVersion,
    };
  },
};
