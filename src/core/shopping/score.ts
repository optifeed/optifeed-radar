/**
 * Per-product scoring (M12a): the two layers aggregated into one {@link SkuReport}.
 *
 * The visibility layer reuses M7's aggregation verbatim (`scorePerEngine` +
 * `compositeScore`), so a product's number means the same thing as a brand's and
 * there is only ever one scoring methodology. The named layer is summarized as
 * sentiment, exactly as branded prompts are in the brand check.
 *
 * The third piece has no equivalent in the brand check: the SHELF. When a
 * product is absent, "0 mentions" is the least useful thing we could report, so
 * the products the engines recommended instead are aggregated into a share of
 * voice and lead that product's section (design requirement 3).
 */
import { compositeScore, scorePerEngine } from '../scoring/index.js';
import { fold } from '../text.js';
import type {
  EngineAnswer,
  EngineScore,
  ProductEntity,
  Reputation,
} from '../types.js';
import {
  productTerms,
  shelfEntryIsProduct,
  type ProductMention,
} from './detect.js';

/** One row of a product-level share of voice: what the shelf actually holds. */
export interface ShelfShareRow {
  /** The product name, canonicalized to the merchant's own name when it is theirs. */
  name: string;
  /** True when this is one of the merchant's own products. */
  isYours: boolean;
  /** Answers that recommended it (once per answer, however often it appears). */
  mentions: number;
  sharePct: number;
}

/** One product's full result: visibility, reputation, and the shelf around it. */
export interface SkuReport {
  /** The merchant's name for the product. */
  product: string;
  aliases?: string[];
  descriptor?: string;
  /**
   * 0-100 product visibility over the category prompts, or `null` when that
   * layer was never asked (no descriptor and no category). Null is not zero: an
   * unmeasured product has no score, while zero means engines never named it.
   */
  visibility: number | null;
  /** Per-engine breakdown of the visibility layer. */
  engines: EngineScore[];
  /**
   * Category prompts this product ASKED FOR, whatever came back.
   *
   * Distinct from {@link SkuReport.answers}, which counts what arrived. Zero
   * here means the layer was never written (no descriptor and no store
   * category) and the merchant can fix it; zero answers against a non-zero
   * count means the run could not complete those asks (a cost cap, a failed
   * engine), which is the RUN's problem, not the product list's. Collapsing
   * the two told a cap-truncated merchant to go add a descriptor.
   */
  categoryPrompts: number;
  /** Category answers analyzed for this product. */
  answers: number;
  /** Category answers that named it. */
  mentions: number;
  /** Mean shelf rank where it appeared with one, else null. */
  avgPosition: number | null;
  /** Sentiment from the product-named layer. Absent when it was not asked. */
  reputation?: Reputation;
  /** Product-level share of voice across the category answers. */
  shelf: ShelfShareRow[];
  /** Per-answer detail for the category layer (the evidence renderers show). */
  rows: ProductMention[];
  /** Per-answer detail for the named layer. */
  reputationRows: ProductMention[];
}

/** One analyzed answer: the raw answer plus this product's reading of it. */
export interface AnalyzedAnswer {
  answer: EngineAnswer;
  result: ProductMention;
}

export interface ScoreProductInput {
  product: ProductEntity;
  /** Category prompts requested for this product (not how many were answered). */
  categoryPrompts: number;
  /** Category-prompt answers, analyzed for this product. */
  visibility: AnalyzedAnswer[];
  /** Product-named answers, analyzed for this product. */
  reputation: AnalyzedAnswer[];
  /** Every product the merchant listed, so the shelf can mark what is theirs. */
  owners: ProductEntity[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Count sentiment across the named-layer answers. */
function summarizeReputation(rows: AnalyzedAnswer[]): Reputation {
  const prompts = new Set(rows.map((r) => r.answer.prompt)).size;
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  for (const { result } of rows) {
    if (result.sentiment === 'positive') positive++;
    else if (result.sentiment === 'negative') negative++;
    else neutral++;
  }
  return { prompts, answers: rows.length, positive, neutral, negative };
}

/**
 * Aggregate the recommendation lists into a product-level share of voice.
 *
 * Counted ONCE per answer per product: an answer that mentions a rival three
 * times in its blurb is one recommendation, not three. Entries that are one of
 * the merchant's own products are folded onto that product's own name, so a
 * shelf never lists "Aria II" and "Aria 2" as two different machines.
 */
export function shelfShareOfVoice(
  rows: ProductMention[],
  owners: ProductEntity[],
): ShelfShareRow[] {
  const counts = new Map<
    string,
    { name: string; isYours: boolean; n: number }
  >();

  for (const row of rows) {
    const seen = new Set<string>();
    for (const entry of row.shelf) {
      // Matched on every name the merchant gave (aliases included), so an
      // engine that writes "Aria II" is not counted as a rival of "Aria 2".
      const owner = owners.find((own) =>
        shelfEntryIsProduct(entry, productTerms(own)),
      );
      const name = owner?.name ?? entry;
      const key = fold(name).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current) current.n += 1;
      else counts.set(key, { name, isYours: owner !== undefined, n: 1 });
    }
  }

  const total = [...counts.values()].reduce((sum, row) => sum + row.n, 0);
  return [...counts.values()]
    .map((row) => ({
      name: row.name,
      isYours: row.isYours,
      mentions: row.n,
      sharePct: total === 0 ? 0 : round1((row.n / total) * 100),
    }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
}

/** Aggregate one product's analyzed answers into its {@link SkuReport}. */
export function scoreProduct(input: ScoreProductInput): SkuReport {
  const { product, categoryPrompts, visibility, reputation, owners } = input;

  const answers = visibility.map((v) => v.answer);
  const results = visibility.map((v) => v.result);
  const engines = scorePerEngine(answers, results);
  const mentioned = results.filter((r) => r.mentioned);
  const positions = mentioned
    .map((r) => r.position)
    .filter((p): p is number => p !== null);

  return {
    product: product.name,
    ...(product.aliases?.length ? { aliases: product.aliases } : {}),
    ...(product.descriptor ? { descriptor: product.descriptor } : {}),
    // No category answers means this layer was never measured. `compositeScore`
    // already returns null for an empty engine set - kept explicit here because
    // the difference between "not measured" and "scored 0" is the difference
    // between an honest report and an accusation (rule #6).
    visibility: compositeScore(engines),
    engines,
    categoryPrompts,
    answers: results.length,
    mentions: mentioned.length,
    avgPosition:
      positions.length === 0
        ? null
        : round1(positions.reduce((a, b) => a + b, 0) / positions.length),
    ...(reputation.length > 0
      ? { reputation: summarizeReputation(reputation) }
      : {}),
    shelf: shelfShareOfVoice(results, owners),
    rows: results,
    reputationRows: reputation.map((r) => r.result),
  };
}
