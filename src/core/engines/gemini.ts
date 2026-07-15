/**
 * Gemini adapter (M6): parametric generateContent, with search grounding added
 * when `mode` is grounded. Grounding that is unavailable degrades to a plain
 * answer (the runner surfaces the degrade), never an error.
 */
import type { ParsedResponse, ProviderSpec } from './adapter.js';

interface GenerateShape {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

export const geminiSpec: ProviderSpec = {
  id: 'gemini',
  kind: 'parametric',
  defaultModel: 'gemini-2.5-flash',
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
      ...(maxTokens
        ? { generationConfig: { maxOutputTokens: maxTokens } }
        : {}),
    },
  }),
  parse: (json): ParsedResponse => {
    const r = json as GenerateShape;
    const candidate = r.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    const citations = candidate?.groundingMetadata?.groundingChunks
      ?.map((c) => c.web?.uri)
      .filter((u): u is string => Boolean(u));
    return {
      text,
      citations: citations && citations.length > 0 ? citations : undefined,
      usage: r.usageMetadata
        ? {
            input: r.usageMetadata.promptTokenCount ?? 0,
            output: r.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined,
      model: r.modelVersion,
    };
  },
};
