/**
 * The ranking delta (M12a): the merchant's own order against AI's.
 *
 * This is the headline of a shopping run (design requirement 1). Typing the
 * product list in order is not a fallback for discovery - it captures what the
 * merchant BELIEVES their ranking is, which discovery could never know. The
 * delta against what engines actually recommend is the finding: "your #1 is
 * AI's #4", "your best seller never appears; your #3 carries the shelf".
 */
import type { SkuReport } from './score.js';

/** One product's place in both rankings. */
export interface RankingDeltaRow {
  product: string;
  /** 1-based position the merchant gave it (their input order). */
  merchantRank: number;
  /**
   * 1-based position among the products engines actually named, or `null` when
   * this product was never named (or never measured). Null is NOT last place: a
   * product engines ignore has no rank, and inventing one would turn "absent
   * from the conversation" into "ranked bottom", which is a different claim.
   */
  aiRank: number | null;
  /**
   * `aiRank - merchantRank`: positive means engines place it LOWER than the
   * merchant does, negative means higher. `null` whenever `aiRank` is.
   */
  delta: number | null;
  /** Product visibility 0-100, or null when the category layer was not asked. */
  visibility: number | null;
  /** Category answers that named it. */
  mentions: number;
  /** False when this product's category layer was never asked (no subject). */
  measured: boolean;
}

/**
 * Rank the products by what the engines did, and pair it with the merchant's
 * own order. Rows come back in MERCHANT order: their ranking is the frame the
 * delta is read against.
 */
export function computeRankingDelta(reports: SkuReport[]): RankingDeltaRow[] {
  // Only products the engines actually named can be ranked. Everything else -
  // never mentioned, or never measured - stays unranked rather than being piled
  // at the bottom in an arbitrary order.
  const ranked = reports
    .filter((r) => r.answers > 0 && r.mentions > 0)
    .sort(
      (a, b) =>
        (b.visibility ?? 0) - (a.visibility ?? 0) ||
        b.mentions - a.mentions ||
        a.merchantRank - b.merchantRank,
    );
  const aiRanks = new Map<string, number>(
    ranked.map((r, i) => [r.product, i + 1]),
  );

  return reports.map((report) => {
    const aiRank = aiRanks.get(report.product) ?? null;
    return {
      product: report.product,
      merchantRank: report.merchantRank,
      aiRank,
      delta: aiRank === null ? null : aiRank - report.merchantRank,
      visibility: report.visibility,
      mentions: report.mentions,
      measured: report.answers > 0,
    };
  });
}
