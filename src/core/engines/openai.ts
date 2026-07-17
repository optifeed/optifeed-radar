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
  defaultModel: 'gpt-4o-mini',
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
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
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
      return {
        text,
        citations: citations.length ? citations : undefined,
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
