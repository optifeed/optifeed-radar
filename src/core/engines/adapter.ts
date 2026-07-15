/**
 * The uniform adapter over all providers (M6). A `ProviderSpec` supplies the
 * per-provider wire details (endpoint, request, response parsing); `createAdapter`
 * wraps a spec with shared retry/backoff, cost recording, and a clock. New
 * engines are one small spec file + a registry line.
 */
import { costOfCall, MODEL_PRICING } from '../costs.js';
import type { EngineAnswer, EngineId, EngineKind } from '../types.js';
import { type HttpPost, type RetryOptions, postJsonWithRetry } from './http.js';

export type AskMode = EngineKind; // 'parametric' | 'grounded'

export interface AskOptions {
  mode?: AskMode;
  maxTokens?: number;
}

export interface EngineAdapter {
  id: EngineId;
  kind: EngineKind;
  /** Resolved model id this adapter answers with (used for cost/judge). */
  model: string;
  available(): boolean;
  ask(prompt: string, opts?: AskOptions): Promise<EngineAnswer>;
}

export interface ParsedResponse {
  text: string;
  citations?: string[];
  usage?: { input: number; output: number };
  model?: string;
}

export interface BuildRequestArgs {
  prompt: string;
  model: string;
  mode: AskMode;
  apiKey: string;
  maxTokens?: number;
}

export interface ProviderSpec {
  id: EngineId;
  kind: EngineKind;
  defaultModel: string;
  supportsGrounded?: boolean;
  endpoint: (mode: AskMode, model: string) => string;
  buildRequest: (args: BuildRequestArgs) => {
    headers: Record<string, string>;
    body: unknown;
  };
  parse: (json: unknown, mode: AskMode) => ParsedResponse;
}

export interface AdapterDeps {
  httpPost: HttpPost;
  /** Resolved API key; undefined means the adapter is unavailable. */
  apiKey?: string;
  /** Override the spec's default model. */
  model?: string;
  /** Clock, injected for deterministic tests. */
  now?: () => string;
  retry?: RetryOptions;
}

function computeCost(
  model: string,
  usage: { input: number; output: number } | undefined,
): number {
  if (!usage) return 0;
  const pricing = MODEL_PRICING.models[model];
  if (!pricing) return 0;
  return costOfCall(pricing, usage.input, usage.output);
}

export function createAdapter(
  spec: ProviderSpec,
  deps: AdapterDeps,
): EngineAdapter {
  const model = deps.model ?? spec.defaultModel;
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    id: spec.id,
    kind: spec.kind,
    model,
    available: () => Boolean(deps.apiKey),
    async ask(prompt, opts = {}) {
      if (!deps.apiKey) throw new Error(`${spec.id}: no API key configured`);
      const mode: AskMode = opts.mode ?? spec.kind;
      const req = spec.buildRequest({
        prompt,
        model,
        mode,
        apiKey: deps.apiKey,
        maxTokens: opts.maxTokens,
      });
      const json = await postJsonWithRetry(
        deps.httpPost,
        spec.endpoint(mode, model),
        { headers: req.headers, body: JSON.stringify(req.body) },
        deps.retry,
      );
      const parsed = spec.parse(json, mode);
      // Report the provider's actual (often dated) model id, but price by the
      // configured model - only that key is guaranteed to be in MODEL_PRICING,
      // so pricing by the echoed dated id would silently cost $0.
      return {
        engine: spec.id,
        kind: mode,
        prompt,
        text: parsed.text,
        citations: parsed.citations,
        model: parsed.model ?? model,
        tokens: parsed.usage,
        costUsd: computeCost(model, parsed.usage),
        ts: now(),
      };
    },
  };
}
