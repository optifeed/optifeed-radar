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

/**
 * Bump on any breaking change to a persisted/JSON shape.
 *
 * 0.2 (2026-07-17): `score` became `number | null` on `ScoreReport` and
 * `VisibilityEnvelope` - null means the run measured nothing. A 0.1 consumer
 * reading a 0.2 snapshot would do arithmetic on null, so this is breaking.
 * Bumped deliberately while unpublished, when it is still free: after launch,
 * every reader in the wild would have to handle both. Cached 0.1 profiles and
 * query packs are re-discovered rather than trusted (SchemaVersionError).
 */
export const SCHEMA_VERSION = '0.2';

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

/**
 * What kind of business this is, which decides the prompt axis (M5a).
 *
 * A `retailer` sells other makers' products, so buyers ask WHERE to buy; a
 * `maker` sells its own, so buyers ask WHAT to buy. `service` and any unknown
 * value take the maker path, which is the behavior that shipped before M5a.
 */
export type BusinessType = 'retailer' | 'maker' | 'service';

/** The editable fields of a {@link BrandProfile} that carry a source. */
export type ProfileField =
  | 'brand'
  | 'aliases'
  | 'category'
  | 'offerings'
  | 'locale'
  | 'competitors'
  | 'businessType';

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
  /** Decides the query axis (M5a); absent means the maker path. */
  businessType?: BusinessType;
  degraded?: boolean;
  generatedAt?: string;
  /** Provenance per field; `user` fields survive `--refresh` (M4). */
  sources?: ProfileSources;
}

/**
 * One product the merchant named for a `shopping` run (M12a).
 *
 * There is no discovery: the merchant types this list, and its ORDER is their
 * own ranking of the products (index 0 = their #1). That belief is the thing
 * discovery could never capture, and the delta against the ranking AI engines
 * actually show is the headline of a shopping run.
 */
export interface ProductEntity {
  /** The product name as a shopper would see it, e.g. "Aria 2". */
  name: string;
  /** Other names the same product goes by ("Aria II"), matched at scoring. */
  aliases?: string[];
  /**
   * What the product IS ("quiet home espresso machine"). Rescues opaque names:
   * without it, a name like "Aria 2" tells the query generator nothing about
   * which category prompts would surface it.
   */
  descriptor?: string;
}

/** Buyer-question intent categories for generated queries (M5). */
export type QueryIntent =
  'best-of' | 'where-to-buy' | 'comparison' | 'problem' | 'trust' | 'local';

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
  /**
   * The internal search queries the engine ran before answering, where the API
   * exposes them (M6, Profound fanout study). Omitted when unavailable, never
   * fabricated (rule #6).
   */
  fanoutQueries?: string[];
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
  /**
   * How many of `answers` show evidence of an actual retrieval (M17). `kind`
   * records the mode that was REQUESTED; a grounded-mode call is a request the
   * model can decline. Only set for engines that report retrieval evidence;
   * absent on snapshots written before this was measured.
   */
  retrievedAnswers?: number;
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
  /**
   * The one headline AI Visibility Score, 0-100 (hard rule #6).
   *
   * `null` when the run measured NOTHING (no engine answered). Not a 0: a
   * fabricated zero reads exactly like a brand that is never recommended, so a
   * failed run would libel the brand and, once `--fail-under` is wired, fail a
   * build over a number that measured nothing.
   */
  score: number | null;
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

/**
 * An engine that answered SOME of its prompts. Distinct from a skipped engine:
 * it produced real, scoreable answers, but on a smaller sample than its
 * neighbours, so its score carries less confidence. The counts are carried (not
 * just a boolean) because "partial" without numbers hides how partial.
 */
export interface PartialEngine {
  engine: EngineId;
  /**
   * Prompts the run asked for - the denominator this engine's score is measured
   * against. Some may never have been sent (the cost guard can refuse them).
   */
  attempted: number;
  /** Prompts it actually answered. */
  answered: number;
  /** Every cause that fired: request errors and/or a cost cap, never guessed. */
  reason: string;
}

/**
 * What a run actually SPENT, split by phase.
 *
 * Sourced from the cost guard, never by summing answers: the guard is the only
 * thing that sees every spender, and discovery, query generation, and the
 * scoring judge carry no answer to sum. `setupUsd` is spent before any engine
 * is asked, which is why the split is reported rather than a bare total.
 */
export interface RunSpend {
  /** Discovery + query generation (spent before the confirm gate's main ask). */
  setupUsd: number;
  /** Engine answers + the scoring judge pass. */
  mainUsd: number;
  /** setupUsd + mainUsd. */
  totalUsd: number;
}

/** The honesty flags a run carries so partial/capped runs are never hidden. */
export interface RunHonesty {
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  /** Engines that answered only some prompts (total failure -> skippedEngines). */
  partialEngines?: PartialEngine[];
  degraded?: boolean;
}
