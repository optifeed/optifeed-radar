/**
 * The shopping data contract (M12a): one stable shape every consumer reads.
 *
 * Deliberately NOT a `VisibilityEnvelope` with products bolted on. A shopping
 * run has no single 0-100 headline - hard rule #9 keeps exactly one of those,
 * and it belongs to `check`. What leads here is the per-product summary, in the
 * one order this module decides (see `orderSkus`), with the detail inside each
 * product's own section.
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
  /** The products as the merchant listed them, in input order. */
  products: ProductEntity[];
  /** Per-product results, in the order every surface shows (see `orderSkus`). */
  skus: SkuReport[];
  /** Raw engine answers - the evidence renderers show, never re-derived. */
  answers: EngineAnswer[];
  /**
   * What the run had to say about itself: products dropped over the cap,
   * template fallbacks, which category a descriptor-less product was measured
   * against.
   *
   * ON THE ENVELOPE, not just returned to the caller, because these change how
   * the numbers should be read and the JSON is a first-class channel: an agent
   * reading ten products has no other way to learn that an eleventh was
   * dropped (the M8 lesson - honesty propagates to every derived artifact).
   */
  notes: string[];
  sampling: ShoppingSampling;
  /** What the run actually spent. Absent means not recorded, never $0.00. */
  spend?: RunSpend;
  costCapped?: boolean;
  skippedEngines?: { engine: EngineId; reason: string }[];
  partialEngines?: PartialEngine[];
  degraded?: boolean;
}

/**
 * Which group a product belongs to before scores are compared at all.
 *
 * A product engines never recommended is the FINDING - it is why the merchant
 * ran this - so it leads, ahead of any score. A product that could not be
 * measured (no category questions written, or none answered this run) sinks to
 * the bottom: those are input and run problems, and sorting them by their
 * absent score would rank them as the worst products, which is a different and
 * false claim (rule #6).
 */
function orderGroup(sku: SkuReport): number {
  if (sku.answers === 0) return 2; // never asked, or asked and unanswered
  if (sku.mentions === 0) return 0; // asked, answered, never recommended
  return 1; // scored
}

/**
 * The ONE ordering every surface shows.
 *
 * Computed here so the envelope carries it to the terminal, JSON, HTML and MCP
 * alike and no renderer re-sorts (or disagrees). This is a SORT, not a ranking
 * of the merchant's products against each other: each product was asked its own
 * category questions, so a higher score means "wins its own shelf more
 * decisively", never "beats the product below it". Renderers say so.
 */
export function orderSkus(skus: SkuReport[]): SkuReport[] {
  // Sort is stable (ES2019), so equal rows keep the order the products were
  // given in. That is the tie-break, and the only meaning input order carries.
  return [...skus].sort(
    (a, b) =>
      orderGroup(a) - orderGroup(b) ||
      (b.visibility ?? 0) - (a.visibility ?? 0) ||
      b.mentions - a.mentions,
  );
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
  /** Run notes; carried onto the envelope so every channel gets them. */
  notes?: string[];
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
    notes,
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
    skus: orderSkus(skus),
    answers,
    notes: notes ?? [],
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
