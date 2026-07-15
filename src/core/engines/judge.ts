/**
 * Adapt an engine adapter into the M1 {@link JudgeClient} (M6). This is the
 * concrete implementation M4/M5 receive - they depend only on the interface.
 */
import type { JudgeClient } from '../types.js';
import type { EngineAdapter } from './adapter.js';

export function createJudgeClient(adapter: EngineAdapter): JudgeClient {
  return {
    model: adapter.model,
    async complete(prompt, opts) {
      const answer = await adapter.ask(prompt, {
        mode: 'parametric',
        maxTokens: opts?.maxTokens,
      });
      return {
        text: answer.text,
        costUsd: answer.costUsd,
        model: answer.model,
      };
    },
  };
}
