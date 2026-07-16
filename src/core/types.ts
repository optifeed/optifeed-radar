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
  /** A physical location/service area, if any; gates local-intent queries (M5). */
  geo?: string;
  competitors: string[];
  degraded?: boolean;
  generatedAt?: string;
  /** Provenance per field; `user` fields survive `--refresh` (M4). */
  sources?: ProfileSources;
}

/** Buyer-question intent categories for generated queries (M5). */
export type QueryIntent =
  'best-of' | 'comparison' | 'problem' | 'trust' | 'local';

/** One generated buyer prompt. */
export interface Query {
  id: string;
  intent: QueryIntent;
  prompt: string;
}

/** An editable, reusable pack of buyer prompts (M5). Lean initial shape. */
export interface QueryPack {
  schema_version: string;
  domain: string;
  queries: Query[];
  generatedAt?: string;
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

/** Sentiment of an answer toward the brand (M7). */
export type Sentiment = 'positive' | 'neutral' | 'negative';

/** Per-answer mention analysis (M7). Lean initial shape. */
export interface MentionResult {
  engine: EngineId;
  prompt: string;
  /** Whether the brand (name/alias/domain) appears. */
  mentioned: boolean;
  /** 1-based rank among detected entities, or null if unranked/absent. */
  position: number | null;
  sentiment: Sentiment;
  /** Known entities (brand + competitors) detected, first-appearance order. */
  entities: string[];
  /** Domains cited by grounded engines. */
  citedDomains: string[];
  /** Flagged for the judge pass (generic-word brand, unclear position). */
  ambiguous: boolean;
  /** Whether the judge pass (pass 2) refined this result. */
  judged?: boolean;
}

/** One engine's aggregated score (M7). */
export interface EngineScore {
  engine: EngineId;
  kind: EngineKind;
  score: number; // 0-100
  mentionRate: number; // 0..1
  avgPosition: number | null;
  answers: number;
  mentions: number;
}

/** A share-of-voice row: the brand or a competitor (M7). */
export interface ShareOfVoiceRow {
  name: string;
  isBrand: boolean;
  mentions: number;
  sharePct: number;
}

/** A cited-source row aggregated across grounded answers (M7). */
export interface SourceRow {
  domain: string;
  count: number;
}

/**
 * Reputation from branded prompts that named the brand (M7). Scored apart from
 * the visibility score: naming the brand guarantees a mention, so those answers
 * measure sentiment, not whether the AI surfaced the brand unprompted. Keeping
 * them out of the headline score preserves its meaning (hard rule #6).
 */
export interface Reputation {
  /** Distinct branded prompts asked. */
  prompts: number;
  /** Engine answers to those prompts. */
  answers: number;
  positive: number;
  neutral: number;
  negative: number;
}

/** The scoring output for a run (M7). M8 wraps this into the public envelope. */
export interface ScoreReport {
  schema_version: string;
  domain: string;
  /** The one headline AI Visibility Score, 0-100 (hard rule #6). */
  score: number;
  /** Scoring methodology version, so a diff can flag cross-version deltas (rule #2). */
  scoringVersion: number;
  engines: EngineScore[];
  mentions: MentionResult[];
  shareOfVoice: ShareOfVoiceRow[];
  sources: SourceRow[];
  /** Sentiment from branded prompts, scored apart from the score. Absent if none. */
  reputation?: Reputation;
  /** Judge-pass usage, surfaced for honesty. */
  sampling: { answers: number; judged: number; judgeRateCap: number };
  generatedAt?: string;
}

/** The honesty flags a run carries so partial/capped runs are never hidden. */
export interface RunHonesty {
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  degraded?: boolean;
}

// --- M14 lint-feed (see PROTOCOL-NOTES.md sections 6-7 for the rule spec) ---

/** Which agentic-commerce protocol a lint rule pertains to (`both` = shared). */
export type FeedProtocol = 'acp' | 'ucp' | 'both';

/**
 * A product normalized from a feed (the fields the lint rules test). Common
 * fields are typed; `raw` keeps every parsed key (lower-cased) for rules and
 * evidence. All optional - a feed's whole point is that fields may be missing.
 */
export interface FeedProduct {
  id?: string;
  title?: string;
  description?: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  imageUrl?: string;
  url?: string;
  /** Price as authored, e.g. `"29.99 USD"` or `"29.99"`. */
  price?: string;
  /** ISO 4217 currency if separable from the price. */
  currency?: string;
  availability?: string;
  /** Every parsed field, keys lower-cased; the source of truth for extra rules. */
  raw: Record<string, string>;
}

/**
 * One table-driven lint rule. `violated` returns true when the product breaks
 * the rule (a finding is produced). The table is the reviewable spec - a
 * non-engineer can read `LINT_RULES` and see exactly what is checked.
 */
export interface LintRule {
  id: string;
  protocol: FeedProtocol;
  severity: Severity;
  /** The product field this rule concerns (drives the per-field graded score). */
  field: string;
  message: string;
  docsUrl: string;
  violated(product: FeedProduct): boolean;
}

/** A rule violation on one product. */
export interface LintFinding {
  ruleId: string;
  protocol: FeedProtocol;
  severity: Severity;
  field: string;
  message: string;
  docsUrl: string;
  /** The product's id, or `#<index>` when the feed gave none. */
  sku: string;
}

/** Findings for one product. */
export interface ProductLintResult {
  sku: string;
  findings: LintFinding[];
}

/** Readiness verdict for one protocol across the feed. */
export interface ProtocolReadiness {
  protocol: 'acp' | 'ucp';
  /**
   * 0-100: share of products with no error-severity finding for this protocol.
   * `null` when the feed could not be assessed (nothing parsed) - never a
   * fabricated 0 over an unevaluated feed (rule #6).
   */
  score: number | null;
  /** Honest verdict: `ready` | `nearly ready` | `not ready` | `not assessed`. */
  verdict: string;
}

/** The lint-feed report (M14). Carries `schema_version` (hard rule #2). */
export interface FeedLintReport {
  schema_version: string;
  /** Where the feed came from (a URL, or `inline`). */
  source: string;
  format: 'xml' | 'json' | 'csv' | 'tsv' | 'unknown';
  productCount: number;
  /** Per-product results (products with at least one finding). */
  products: ProductLintResult[];
  /** Finding counts by severity across the whole feed. */
  summary: { error: number; warn: number; info: number };
  /**
   * Feed-level quality score 0-100 (per-field graded, per the Rails model).
   * `null` when the feed could not be assessed (nothing parsed) - an honest
   * "not assessed", never a fabricated 0 over an unevaluated feed (rule #6).
   */
  feedScore: number | null;
  /** Per-protocol readiness verdicts. */
  readiness: ProtocolReadiness[];
  /** Parse problems (e.g. malformed XML) - surfaced, never thrown (hard rule #3). */
  parseErrors: string[];
}
