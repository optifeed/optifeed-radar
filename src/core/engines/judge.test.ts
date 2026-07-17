import { describe, expect, it } from 'vitest';
import { createAdapter } from './adapter.js';
import type { HttpPost } from './http.js';
import { createJudgeClient } from './judge.js';
import { openaiSpec } from './openai.js';

const chatBody = {
  choices: [{ message: { content: 'verdict: mentioned' } }],
  usage: { prompt_tokens: 8, completion_tokens: 4 },
};
const httpPost: HttpPost = async () => ({
  status: 200,
  json: async () => chatBody,
  text: async () => '',
});

describe('createJudgeClient', () => {
  it('exposes the adapter model and round-trips a completion (M1 JudgeClient)', async () => {
    const adapter = createAdapter(openaiSpec, {
      httpPost,
      apiKey: 'k',
      now: () => 'ts',
      // Pinned: the contract under test is "the judge exposes ITS adapter's
      // model", not whatever today's default happens to be.
      model: 'gpt-4o-mini',
    });
    const judge = createJudgeClient(adapter);

    expect(judge.model).toBe('gpt-4o-mini');
    const res = await judge.complete('is Acme mentioned?');
    expect(res.text).toBe('verdict: mentioned');
    expect(res.model).toBe('gpt-4o-mini');
    expect(res.costUsd).toBeGreaterThan(0);
  });
});
