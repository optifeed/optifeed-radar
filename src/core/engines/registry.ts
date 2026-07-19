/**
 * Build the set of engine adapters from config/env (M6). Adding an engine is a
 * one-line change here plus its spec file.
 */
import { ENGINE_KEY_ENV } from '../config.js';
import type { EngineId } from '../types.js';
import { type EngineAdapter, createAdapter } from './adapter.js';
import { anthropicSpec } from './anthropic.js';
import { geminiSpec } from './gemini.js';
import { type HttpPost, type RetryOptions, defaultHttpPost } from './http.js';
import { openaiSpec } from './openai.js';
import { perplexitySpec } from './perplexity.js';

const SPECS = [openaiSpec, anthropicSpec, geminiSpec, perplexitySpec];

export interface CreateAdaptersOptions {
  env: Record<string, string | undefined>;
  httpPost?: HttpPost;
  models?: Partial<Record<EngineId, string>>;
  now?: () => string;
  retry?: RetryOptions;
  /**
   * Build adapters for only these engine ids (in spec order). Omit for all
   * four. Lets a caller that needs a single adapter (e.g. the judge) avoid
   * constructing three throwaway adapters.
   */
  only?: EngineId[];
}

export function createEngineAdapters(
  opts: CreateAdaptersOptions,
): EngineAdapter[] {
  const httpPost = opts.httpPost ?? defaultHttpPost;
  const specs = opts.only
    ? SPECS.filter((spec) => opts.only!.includes(spec.id))
    : SPECS;
  return specs.map((spec) =>
    createAdapter(spec, {
      httpPost,
      apiKey: opts.env[ENGINE_KEY_ENV[spec.id]],
      model: opts.models?.[spec.id],
      now: opts.now,
      retry: opts.retry,
    }),
  );
}
