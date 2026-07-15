/**
 * Fan prompts across adapters, partial-failure tolerant (M6).
 *
 * One adapter's total failure never kills the run - it is moved to
 * `skippedEngines` with a reason. Per-provider concurrency is bounded; per-call
 * cost is recorded into an optional CostGuard.
 */
import type { CostGuard } from '../costs.js';
import type { EngineAnswer, EngineId } from '../types.js';
import type { AskMode, EngineAdapter } from './adapter.js';

export interface SkippedEngine {
  engine: EngineId;
  reason: string;
}

export interface AskAllResult {
  answers: EngineAnswer[];
  skippedEngines: SkippedEngine[];
}

export interface AskAllOptions {
  mode?: AskMode;
  guard?: CostGuard;
  /** Max concurrent requests per provider (default 4). */
  concurrency?: number;
}

/** Run `fn` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

export async function askAll(
  prompts: string[],
  adapters: EngineAdapter[],
  opts: AskAllOptions = {},
): Promise<AskAllResult> {
  const concurrency = opts.concurrency ?? 4;
  const skippedEngines: SkippedEngine[] = [];
  const answers: EngineAnswer[] = [];

  const available: EngineAdapter[] = [];
  for (const adapter of adapters) {
    if (adapter.available()) available.push(adapter);
    else skippedEngines.push({ engine: adapter.id, reason: 'no API key' });
  }

  const perAdapter = await Promise.all(
    available.map(async (adapter) => {
      const settled = await mapLimit(prompts, concurrency, async (prompt) => {
        try {
          return {
            ok: true as const,
            answer: await adapter.ask(prompt, { mode: opts.mode }),
          };
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      const ok = settled.filter((s) => s.ok);
      if (prompts.length > 0 && ok.length === 0) {
        const firstError = settled.find((s) => !s.ok);
        return {
          skip: {
            engine: adapter.id,
            reason:
              firstError && !firstError.ok
                ? firstError.error
                : 'all requests failed',
          },
          answers: [] as EngineAnswer[],
        };
      }
      return { answers: ok.map((s) => s.answer), skip: undefined };
    }),
  );

  for (const result of perAdapter) {
    if (result.skip) skippedEngines.push(result.skip);
    for (const answer of result.answers) {
      answers.push(answer);
      opts.guard?.record(answer.costUsd);
    }
  }

  return { answers, skippedEngines };
}
