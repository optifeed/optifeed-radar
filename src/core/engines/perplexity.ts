/** Perplexity adapter (M6): grounded (sonar); citations are first-class. */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

interface SonarShape {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export const perplexitySpec: ProviderSpec = {
  id: 'perplexity',
  kind: 'grounded',
  defaultModel: 'sonar',
  endpoint: () => 'https://api.perplexity.ai/chat/completions',
  buildRequest: ({ prompt, model, apiKey }) => ({
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: { model, messages: [{ role: 'user', content: prompt }] },
  }),
  parse: (json): ParsedResponse => {
    const r = json as SonarShape;
    return {
      text: r.choices?.[0]?.message?.content ?? '',
      // Citations expected; absence is a degrade the caller can flag, not a throw.
      citations: r.citations,
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
