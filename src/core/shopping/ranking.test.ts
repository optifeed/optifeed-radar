import { describe, expect, it } from 'vitest';
import type { SkuReport } from './score.js';
import { computeRankingDelta } from './ranking.js';

function sku(
  over: Partial<SkuReport> & { product: string; merchantRank: number },
): SkuReport {
  return {
    visibility: 0,
    engines: [],
    answers: 6,
    mentions: 0,
    avgPosition: null,
    shelf: [],
    rows: [],
    reputationRows: [],
    ...over,
  };
}

describe('computeRankingDelta', () => {
  it('shows the merchant #1 sitting fourth with the engines', () => {
    const rows = computeRankingDelta([
      sku({ product: 'Aria 2', merchantRank: 1, visibility: 10, mentions: 1 }),
      sku({
        product: 'Presto X',
        merchantRank: 2,
        visibility: 40,
        mentions: 4,
      }),
      sku({
        product: 'Brew Mini',
        merchantRank: 3,
        visibility: 70,
        mentions: 6,
      }),
      sku({
        product: 'Cafe One',
        merchantRank: 4,
        visibility: 55,
        mentions: 5,
      }),
    ]);

    expect(rows.map((r) => r.product)).toEqual([
      'Aria 2',
      'Presto X',
      'Brew Mini',
      'Cafe One',
    ]);
    expect(rows[0]).toMatchObject({ merchantRank: 1, aiRank: 4, delta: 3 });
    expect(rows[2]).toMatchObject({ merchantRank: 3, aiRank: 1, delta: -2 });
  });

  it('leaves a product the engines never named unranked, not last', () => {
    const rows = computeRankingDelta([
      sku({ product: 'Aria 2', merchantRank: 1, visibility: 0, mentions: 0 }),
      sku({
        product: 'Presto X',
        merchantRank: 2,
        visibility: 30,
        mentions: 3,
      }),
    ]);

    expect(rows[0]).toMatchObject({
      product: 'Aria 2',
      aiRank: null,
      delta: null,
      mentions: 0,
    });
    expect(rows[1]?.aiRank).toBe(1);
  });

  it('breaks a score tie by mentions, then by the merchant order', () => {
    const rows = computeRankingDelta([
      sku({ product: 'A', merchantRank: 1, visibility: 20, mentions: 2 }),
      sku({ product: 'B', merchantRank: 2, visibility: 20, mentions: 3 }),
      sku({ product: 'C', merchantRank: 3, visibility: 20, mentions: 2 }),
    ]);
    expect(rows.map((r) => r.aiRank)).toEqual([2, 1, 3]);
  });

  it('does not rank a product whose category layer was never measured', () => {
    const rows = computeRankingDelta([
      sku({
        product: 'Opaque',
        merchantRank: 1,
        visibility: null,
        answers: 0,
        mentions: 0,
      }),
      sku({
        product: 'Presto X',
        merchantRank: 2,
        visibility: 30,
        mentions: 3,
      }),
    ]);
    expect(rows[0]).toMatchObject({
      aiRank: null,
      delta: null,
      measured: false,
    });
    expect(rows[1]).toMatchObject({ aiRank: 1, measured: true });
  });
});
