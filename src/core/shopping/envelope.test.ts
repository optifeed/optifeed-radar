import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type ProductEntity,
} from '../types.js';
import { isPartialRun } from '../output/index.js';
import { buildShoppingEnvelope } from './envelope.js';
import { SHOPPING_JUDGE_RATE_CAP } from './judge.js';
import type { SkuReport } from './score.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  competitors: [],
};

const PRODUCTS: ProductEntity[] = [{ name: 'Aria 2' }, { name: 'Presto X' }];

function answer(prompt: string): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt,
    text: '1. **Aria 2**',
    model: 'gpt-5.4-mini',
    costUsd: 0.001,
    ts: '2026-07-23T00:00:00.000Z',
  };
}

function sku(product: string, merchantRank: number): SkuReport {
  return {
    product,
    merchantRank,
    visibility: 40,
    engines: [],
    categoryPrompts: 3,
    answers: 2,
    mentions: 1,
    avgPosition: 1,
    shelf: [],
    rows: [],
    reputationRows: [],
  };
}

const BASE = {
  profile: PROFILE,
  products: PRODUCTS,
  skus: [sku('Aria 2', 1), sku('Presto X', 2)],
  answers: [answer('best espresso machine'), answer('is the Aria 2 worth it?')],
  rowsAnalyzed: 4,
  judged: 1,
  generatedAt: '2026-07-23T00:00:00.000Z',
};

describe('buildShoppingEnvelope', () => {
  it('carries the schema version, the delta and honest sampling', () => {
    const env = buildShoppingEnvelope(BASE);

    expect(env.schema_version).toBe(SCHEMA_VERSION);
    expect(env.domain).toBe('acme.example');
    expect(env.rankingDelta.map((r) => r.product)).toEqual([
      'Aria 2',
      'Presto X',
    ]);
    expect(env.sampling).toMatchObject({
      nProducts: 2,
      nPrompts: 2,
      nAnswers: 2,
      nRows: 4,
      judged: 1,
      judgeRateCap: SHOPPING_JUDGE_RATE_CAP,
    });
    expect(env.sampling.varianceNote.length).toBeGreaterThan(0);
  });

  it('leaves a clean run free of honesty flags', () => {
    const env = buildShoppingEnvelope(BASE);
    expect(env.costCapped).toBeUndefined();
    expect(env.skippedEngines).toBeUndefined();
    expect(env.degraded).toBeUndefined();
    expect(isPartialRun(env)).toBe(false);
  });

  it('carries every honesty signal it was given, and reads as partial', () => {
    const env = buildShoppingEnvelope({
      ...BASE,
      honesty: {
        costCapped: true,
        skippedEngines: [{ engine: 'gemini', reason: 'no API key' }],
        partialEngines: [
          { engine: 'openai', attempted: 8, answered: 3, reason: 'cost cap' },
        ],
        degraded: true,
      },
      spend: { setupUsd: 0.01, mainUsd: 0.2, totalUsd: 0.21 },
    });

    expect(env.costCapped).toBe(true);
    expect(env.skippedEngines).toHaveLength(1);
    expect(env.partialEngines).toHaveLength(1);
    expect(env.degraded).toBe(true);
    expect(env.spend?.totalUsd).toBe(0.21);
    expect(isPartialRun(env)).toBe(true);
  });
});
