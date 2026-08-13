/**
 * OpenAI adapter (M6): chat completions (parametric) and the Responses API with
 * web_search (grounded) behind one spec, selected by `mode`.
 */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

interface ChatShape {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * The RAW `/v1/responses` shape (verified live 2026-07-17; fixture at
 * `test/fixtures/engines/openai-grounded-real.json`).
 *
 * Note what is NOT here: `output_text` and `citations`. Both are convenience
 * properties the official SDK synthesizes - they do not exist on the HTTP
 * response. Reading them off the raw body yields an empty answer with no
 * citations while the call still bills full price, so parse `output[]`.
 */
interface ResponsesShape {
  output?: {
    type?: string;
    /** Present on `web_search_call`: the queries the engine actually ran. */
    action?: { queries?: string[]; query?: string };
    content?: {
      type?: string;
      text?: string;
      annotations?: { type?: string; url?: string }[];
    }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export const openaiSpec: ProviderSpec = {
  id: 'openai',
  kind: 'parametric',
  // A PINNED snapshot, deliberately, after two floating aliases broke this
  // adapter in a single day.
  //
  // The history is the argument. `gpt-5.3-chat-latest` was chosen because an
  // alias "cannot go 404 out from under us" - then OpenAI retired the
  // per-generation aliases and it began answering HTTP 404 "has been
  // deprecated", so every OpenAI answer in every run failed. Its replacement,
  // the bare `chat-latest`, cannot 404 that way but repoints without notice,
  // and NOTHING in the response reveals when it moves: `model` echoes the alias
  // back rather than a dated id, and `system_fingerprint` comes back null (both
  // checked live 2026-08-13). A measurement whose subject can change silently
  // cannot support `diff`, which exists to attribute change over time.
  //
  // OpenAI's own guidance is to pin: it recommends GPT-5.6 for production API
  // usage and advises against `chat-latest` there.
  //
  // Know the trade this makes. `chat-latest` tracked "the latest Instant model
  // currently used in ChatGPT"; `gpt-5.6-sol` is documented as an API-oriented
  // "frontier model for complex professional work". So this column now measures
  // a model from the family ChatGPT is built on, NOT the exact model a consumer
  // is served. That is a deliberate exchange of fidelity for reproducibility,
  // and it is why re-pointing at any `-latest` id is a regression, not an
  // update (a test asserts the default contains no "latest").
  defaultModel: 'gpt-5.6-sol',
  supportsGrounded: true,
  endpoint: (mode) =>
    mode === 'grounded'
      ? 'https://api.openai.com/v1/responses'
      : 'https://api.openai.com/v1/chat/completions',
  buildRequest: ({ prompt, model, mode, apiKey, maxTokens }) => {
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (mode === 'grounded') {
      return {
        headers,
        body: { model, input: prompt, tools: [{ type: 'web_search' }] },
      };
    }
    return {
      headers,
      body: {
        model,
        messages: [{ role: 'user', content: prompt }],
        // `max_completion_tokens`, never `max_tokens`: GPT-5 models reject the
        // latter outright (unsupported_parameter -> HTTP 400), while the legacy
        // gpt-4o pair accepts both. Verified live against all four 2026-07-17.
        ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
      },
    };
  },
  parse: (json, mode): ParsedResponse => {
    if (mode === 'grounded') {
      const r = json as ResponsesShape;
      const output = r.output ?? [];
      // Concatenate every output_text part across message items; a response
      // interleaves tool calls (web_search_call) with message items.
      const parts = output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text');
      const text = parts
        .map((c) => c.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();
      // Citations are url_citation annotations on those text parts. Dedupe,
      // preserving order; omit the field entirely when there are none so an
      // ungrounded answer never claims sources (rule #6).
      const urls = parts
        .flatMap((c) => c.annotations ?? [])
        .filter((a) => a.type === 'url_citation')
        .map((a) => a.url)
        .filter((u): u is string => Boolean(u));
      const citations = [...new Set(urls)];
      // Fanout: the queries the engine actually ran, on web_search_call items.
      // `action.queries` is the array; `action.query` carries a single one.
      // Absent = omit the field, never fabricate (rule #6).
      const fanout = output
        .filter((o) => o.type === 'web_search_call')
        .flatMap(
          (o) => o.action?.queries ?? (o.action?.query ? [o.action.query] : []),
        )
        .filter(Boolean);
      const fanoutQueries = [...new Set(fanout)];
      return {
        text,
        citations: citations.length ? citations : undefined,
        fanoutQueries: fanoutQueries.length ? fanoutQueries : undefined,
        usage: r.usage
          ? {
              input: r.usage.input_tokens ?? 0,
              output: r.usage.output_tokens ?? 0,
            }
          : undefined,
        model: r.model,
      };
    }
    const r = json as ChatShape;
    return {
      text: r.choices?.[0]?.message?.content ?? '',
      usage: r.usage
        ? {
            input: r.usage.prompt_tokens ?? 0,
            output: r.usage.completion_tokens ?? 0,
          }
        : undefined,
      model: r.model,
    };
  },
};
