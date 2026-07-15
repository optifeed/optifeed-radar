/**
 * Shared contracts every module imports (M1).
 *
 * These are the stable seams of the codebase. Other modules may make
 * backward-compatible ADDITIONS here (new optional fields, new types) but must
 * not break existing shapes. Every serializable payload carries
 * {@link SCHEMA_VERSION} (hard rule #2).
 *
 * Many data types below are lean initial shapes owned in spirit by a later
 * module (e.g. `BrandProfile` by M4, `AuditReport` by M3); they will grow.
 */

/** Bump on any breaking change to a persisted/JSON shape. */
export const SCHEMA_VERSION = '0.1';

/** The engines v1 supports (all BYO-key). */
export type EngineId = 'openai' | 'anthropic' | 'gemini' | 'perplexity';

/** Grounded engines cite sources; parametric answer from model weights alone. */
export type EngineKind = 'parametric' | 'grounded';

export type Severity = 'info' | 'warn' | 'error';

/** A single audit/scoring observation with evidence. */
export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  evidence?: string;
  affectedEngines?: EngineId[];
}

/** Where a profile field came from; user edits are never overwritten (M4). */
export type FieldSource = 'extracted' | 'llm' | 'user';

/** The editable fields of a {@link BrandProfile} that carry a source. */
export type ProfileField =
  'brand' | 'aliases' | 'category' | 'offerings' | 'locale' | 'competitors';

/** Per-field provenance so `--refresh` can preserve user edits (M4). */
export type ProfileSources = Partial<Record<ProfileField, FieldSource>>;

/** Editable brand profile produced by discovery (M4). Lean initial shape. */
export interface BrandProfile {
  schema_version: string;
  domain: string;
  brand: string;
  aliases: string[];
  category?: string;
  offerings?: string[];
  locale?: string;
  competitors: string[];
  degraded?: boolean;
  generatedAt?: string;
  /** Provenance per field; `user` fields survive `--refresh` (M4). */
  sources?: ProfileSources;
}

/** One judge call abstracted so M4/M5 depend on this, not on M6 (the seam). */
export interface JudgeClient {
  /** Model id this client answers with (used for cost estimation). */
  readonly model: string;
  complete(
    prompt: string,
    opts?: { maxTokens?: number },
  ): Promise<{ text: string; costUsd: number; model: string }>;
}

/** One engine's answer to one prompt (M6). Lean initial shape. */
export interface EngineAnswer {
  engine: EngineId;
  kind: EngineKind;
  prompt: string;
  text: string;
  citations?: string[];
  model: string;
  tokens?: { input: number; output: number };
  costUsd: number;
  ts: string;
}

/** The honesty flags a run carries so partial/capped runs are never hidden. */
export interface RunHonesty {
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  degraded?: boolean;
}
