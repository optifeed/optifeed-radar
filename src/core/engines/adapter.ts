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
  /**
   * Whether this engine can actually search when asked for grounded mode.
   * Mirrors {@link ProviderSpec.supportsGrounded} so cost reservation can tell
   * a real search from a request for one - an engine that cannot ground is
   * neither billed nor reserved for searches it will never run.
   */
  supportsGrounded?: boolean;
  available(): boolean;
  ask(prompt: string, opts?: AskOptions): Promise<EngineAnswer>;
}

export interface ParsedResponse {
  text: string;
  citations?: string[];
  /** The internal search queries the engine ran, where the API exposes them. */
  fanoutQueries?: string[];
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
  searchQueries = 0,
): number {
  const pricing = MODEL_PRICING.models[model];
  if (!pricing) return 0;
  // Per-request and per-search fees are owed even when token usage did not
  // parse: a 2xx whose `usage` block drifted still cost the provider's search
  // charges, so returning 0 would under-report real spend (rule #5).
  if (!usage) {
    return (
      (pricing.perRequestUsd ?? 0) + searchQueries * (pricing.perSearchUsd ?? 0)
    );
  }
  return costOfCall(pricing, usage.input, usage.output, searchQueries);
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
    supportsGrounded: spec.supportsGrounded,
    model,
    available: () => Boolean(deps.apiKey),
    async ask(prompt, opts = {}) {
      if (!deps.apiKey) throw new Error(`${spec.id}: no API key configured`);
      // A requested `grounded` mode only takes effect where the provider can
      // actually ground (a web-search spec, or a natively grounded engine).
      // Otherwise fall back to the spec's native kind so a parametric answer is
      // never mislabelled grounded (rule #6; scoring weights grounded higher).
      const canGround =
        spec.supportsGrounded === true || spec.kind === 'grounded';
      const mode: AskMode =
        opts.mode === 'grounded' && !canGround
          ? spec.kind
          : (opts.mode ?? spec.kind);
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
        fanoutQueries: parsed.fanoutQueries,
        model: parsed.model ?? model,
        tokens: parsed.usage,
        // Price the searches the call actually reported, not an assumption:
        // Google bills grounding per individual search query.
        costUsd: computeCost(model, parsed.usage, parsed.fanoutQueries?.length),
        ts: now(),
      };
    },
  };
}
