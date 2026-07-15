import { describe, expect, it } from 'vitest';
import type { HttpPost } from './http.js';
import { createEngineAdapters } from './registry.js';

const httpPost: HttpPost = async () => ({
  status: 200,
  json: async () => ({}),
  text: async () => '',
});

describe('createEngineAdapters', () => {
  it('builds all four adapters, availability driven by env keys', () => {
    const adapters = createEngineAdapters({
      env: { OPENAI_API_KEY: 'k', PERPLEXITY_API_KEY: 'p' },
      httpPost,
    });

    expect(adapters.map((a) => a.id).sort()).toEqual([
      'anthropic',
      'gemini',
      'openai',
      'perplexity',
    ]);
    const byId = (id: string) => adapters.find((a) => a.id === id)!;
    expect(byId('openai').available()).toBe(true);
    expect(byId('perplexity').available()).toBe(true);
    expect(byId('anthropic').available()).toBe(false);
    expect(byId('gemini').available()).toBe(false);
  });
});
