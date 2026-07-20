/** Anthropic adapter (M6): parametric messages API. */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

interface MessagesShape {
  content?: { type?: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export const anthropicSpec: ProviderSpec = {
  id: 'anthropic',
  kind: 'parametric',
  // Same reasoning as the OpenAI `gpt-4o-mini` -> `-chat-latest` fix: measure the
  // model buyers actually talk to. `claude-haiku-4-5` is the cheap tier nobody
  // chats with, so an Anthropic column measured on it answered a question no
  // buyer asked. Sonnet 5 is what Claude.ai serves most users (verified live
  // 2026-07-20 against /v1/models).
  defaultModel: 'claude-sonnet-5',
  endpoint: () => 'https://api.anthropic.com/v1/messages',
  buildRequest: ({ prompt, model, apiKey, maxTokens }) => ({
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: {
      model,
      max_tokens: maxTokens ?? 1024,
      messages: [{ role: 'user', content: prompt }],
    },
  }),
  parse: (json): ParsedResponse => {
    const r = json as MessagesShape;
    const text = (r.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      usage: r.usage
        ? {
            input: r.usage.input_tokens ?? 0,
            output: r.usage.output_tokens ?? 0,
          }
        : undefined,
      model: r.model,
    };
  },
};
