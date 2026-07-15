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

interface ResponsesShape {
  output_text?: string;
  citations?: string[];
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
      return {
        text: r.output_text ?? '',
        citations: r.citations,
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
