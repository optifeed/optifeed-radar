/**
 * The shopping data contract (M12a): one stable shape every consumer reads.
 *
 * Deliberately NOT a `VisibilityEnvelope` with products bolted on. A shopping
 * run has no single 0-100 headline - hard rule #9 keeps exactly one of those,
 * and it belongs to `check`. What leads here is the RANKING DELTA, with
 * per-product visibility numbers inside each product's own section.
 *
 * The honesty flags are the same four the check envelope carries, so the shared
 * `isPartialRun` / `honestyNotes` in `core/output` apply unchanged.
 */
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type PartialEngine,
  type ProductEntity,
  type RunHonesty,
  type RunSpend,
} from '../types.js';
import { SHOPPING_JUDGE_RATE_CAP } from './judge.js';
import { computeRankingDelta, type RankingDeltaRow } from './ranking.js';
import type { SkuReport } from './score.js';

/**
 * Honest single line about what a product-level score is worth. Shorter samples
 * than a brand check (a few prompts per product), so it says so.
 */
export const SHOPPING_VARIANCE_NOTE =
  'Product scores are estimates from a small sample of shopper prompts and will vary between runs.';

/** The sampling context that keeps a shopping run honest. */
export interface ShoppingSampling {
  /** Products checked this run (after the cap). */
  nProducts: number;
  /** Distinct prompts asked (shared category prompts are asked once). */
  nPrompts: number;
  /** Engine answers received. */
  nAnswers: number;
  /** Product/answer pairs analyzed - one answer feeds every product that asked. */
  nRows: number;
  /** Rows the judge pass re-read (what the run paid for). */
  judged: number;
  /** The judge budget this module runs with (50%, vs the brand check's 30%). */
  judgeRateCap: number;
  varianceNote: string;
}

/** The stable `shopping` envelope every consumer reads (M12a). */
export interface ShoppingEnvelope {
  schema_version: string;
  generatedAt: string;
  domain: string;
  /** The store profile the products were checked against (M4). */
  profile: BrandProfile;
  /** The products as the merchant listed them, in their ranking order. */
  products: ProductEntity[];
  /** THE headline: the merchant's ranking against AI's observed ranking. */
  rankingDelta: RankingDeltaRow[];
  /** Per-product results, in merchant order. */
  skus: SkuReport[];
  /** Raw engine answers - the evidence renderers show, never re-derived. */
  answers: EngineAnswer[];
  sampling: ShoppingSampling;
  /** What the run actually spent. Absent means not recorded, never $0.00. */
  spend?: RunSpend;
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  partialEngines?: PartialEngine[];
  degraded?: boolean;
}

/** Inputs to {@link buildShoppingEnvelope}. */
export interface BuildShoppingEnvelopeInput {
  profile: BrandProfile;
  products: ProductEntity[];
  skus: SkuReport[];
  answers: EngineAnswer[];
  /** Product/answer pairs analyzed (products x their answers). */
  rowsAnalyzed: number;
  /** Rows the judge pass actually read. */
  judged: number;
  honesty?: RunHonesty;
  spend?: RunSpend;
  /** Injected timestamp so builds are deterministic. */
  generatedAt: string;
}

/** Assemble the stable shopping envelope from the pipeline's outputs. */
export function buildShoppingEnvelope(
  input: BuildShoppingEnvelopeInput,
): ShoppingEnvelope {
  const {
    profile,
    products,
    skus,
    answers,
    rowsAnalyzed,
    judged,
    honesty,
    spend,
    generatedAt,
  } = input;

  const envelope: ShoppingEnvelope = {
    schema_version: SCHEMA_VERSION,
    generatedAt,
    domain: profile.domain,
    profile,
    products,
    rankingDelta: computeRankingDelta(skus),
    skus,
    answers,
    sampling: {
      nProducts: products.length,
      nPrompts: new Set(answers.map((a) => a.prompt)).size,
      nAnswers: answers.length,
      nRows: rowsAnalyzed,
      judged,
      judgeRateCap: SHOPPING_JUDGE_RATE_CAP,
      varianceNote: SHOPPING_VARIANCE_NOTE,
    },
    ...(spend ? { spend } : {}),
  };

  // Only attach flags that actually fired, so a clean run's envelope stays
  // clean - and every flag that DID fire is carried, never a subset (rule #6).
  if (honesty?.costCapped) envelope.costCapped = true;
  if (honesty?.degraded) envelope.degraded = true;
  if (honesty?.skippedEngines && honesty.skippedEngines.length > 0) {
    envelope.skippedEngines = honesty.skippedEngines;
  }
  if (honesty?.partialEngines && honesty.partialEngines.length > 0) {
    envelope.partialEngines = honesty.partialEngines;
  }

  return envelope;
}
