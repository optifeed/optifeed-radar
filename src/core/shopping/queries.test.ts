import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
  type ProductEntity,
} from '../types.js';
import {
  VISIBILITY_PROMPTS_PER_PRODUCT,
  generateProductQueries,
} from './queries.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  category: 'home espresso machines',
  locale: 'en-US',
  competitors: ['Breville'],
};

const PRODUCTS: ProductEntity[] = [
  { name: 'Aria 2', descriptor: 'quiet home espresso machine' },
  { name: 'Presto X' },
];

function judgeReturning(text: string): JudgeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    model: 'gpt-5.4-mini',
    calls,
    async complete(prompt) {
      calls.push(prompt);
      return { text, costUsd: 0.0004, model: 'gpt-5.4-mini-2026-01-01' };
    },
  };
}

const GOOD_RESPONSE = JSON.stringify({
  '0': {
    visibility: [
      'best quiet espresso machine for a small kitchen',
      'quiet espresso machine under $500',
      'which espresso machine is quietest',
    ],
    reputation: ['is the Aria 2 worth buying?'],
  },
  '1': {
    visibility: [
      'best espresso machine for beginners',
      'fastest home espresso machine',
      'espresso machine with a built in grinder',
    ],
    reputation: ['Presto X reviews and complaints'],
  },
});

const opts = { generatedAt: '2026-07-23T00:00:00.000Z' };

describe('generateProductQueries', () => {
  it('writes three visibility prompts and one named prompt per product', async () => {
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(GOOD_RESPONSE), guard: new CostGuard() },
      opts,
    );

    expect(VISIBILITY_PROMPTS_PER_PRODUCT).toBe(3);
    const first = result.prompts.filter((p) => p.productIndex === 0);
    expect(first.filter((p) => p.layer === 'visibility')).toHaveLength(3);
    expect(first.filter((p) => p.layer === 'reputation')).toHaveLength(1);
    expect(result.prompts.filter((p) => p.productIndex === 1)).toHaveLength(4);
    expect(result.notes).toEqual([]);
  });

  it('seeds the judge with the brand category, locale and the descriptors', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);
    await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );
    const prompt = judge.calls[0] ?? '';
    expect(prompt).toContain('home espresso machines');
    expect(prompt).toContain('en-US');
    expect(prompt).toContain('quiet home espresso machine');
    expect(judge.calls).toHaveLength(1);
  });

  it('keys prompts by product index, not by the name the judge echoed', async () => {
    const echoedWrong = JSON.stringify({
      '0': {
        visibility: ['best quiet espresso machine'],
        reputation: ['is the ARIA-2 (Aria II) any good?'],
      },
      'Presto 10': { visibility: ['nonsense'], reputation: ['nonsense'] },
    });
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(echoedWrong), guard: new CostGuard() },
      opts,
    );
    const forFirst = result.prompts.filter((p) => p.productIndex === 0);
    expect(
      forFirst.some((p) => p.prompt === 'best quiet espresso machine'),
    ).toBe(true);
    expect(result.prompts.some((p) => p.prompt === 'nonsense')).toBe(false);
  });

  it('drops a visibility prompt that names the product and backfills it', async () => {
    const namesProduct = JSON.stringify({
      '0': {
        visibility: [
          'is the Aria 2 the best quiet espresso machine',
          'best quiet espresso machine for a small kitchen',
          'quiet espresso machine under $500',
        ],
        reputation: ['is the Aria 2 worth buying?'],
      },
    });
    const result = await generateProductQueries(
      PROFILE,
      [PRODUCTS[0]!],
      { judge: judgeReturning(namesProduct), guard: new CostGuard() },
      opts,
    );
    const visibility = result.prompts.filter((p) => p.layer === 'visibility');
    expect(visibility).toHaveLength(3);
    expect(visibility.every((p) => !p.prompt.includes('Aria 2'))).toBe(true);
  });

  it('replaces a reputation prompt that never names the product', async () => {
    const unnamed = JSON.stringify({
      '0': {
        visibility: ['best quiet espresso machine'],
        reputation: ['is it any good?'],
      },
    });
    const result = await generateProductQueries(
      PROFILE,
      [PRODUCTS[0]!],
      { judge: judgeReturning(unnamed), guard: new CostGuard() },
      opts,
    );
    const reputation = result.prompts.filter((p) => p.layer === 'reputation');
    expect(reputation).toHaveLength(1);
    expect(reputation[0]?.prompt).toContain('Aria 2');
  });

  it('falls back to templates and says so when the setup cap refuses the call', async () => {
    const guard = new CostGuard({ maxSetupCostUsd: 0 });
    const judge = judgeReturning(GOOD_RESPONSE);

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(judge.calls).toHaveLength(0);
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.prompts.filter((p) => p.layer === 'reputation')).toHaveLength(
      2,
    );
    expect(result.notes.join(' ')).toContain('cost cap');
  });

  it('falls back to templates and frees the hold when the judge throws', async () => {
    const guard = new CostGuard({ maxSetupCostUsd: 1 });
    const judge: JudgeClient = {
      model: 'gpt-5.4-mini',
      async complete() {
        throw new Error('upstream 500');
      },
    };

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(guard.spendBreakdown.setupUsd).toBe(0);
    expect(guard.costCapped).toBe(false);
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toContain('upstream 500');
  });

  it('skips the visibility layer when a product has no descriptor and no category', async () => {
    const noCategory: BrandProfile = { ...PROFILE, category: undefined };
    const judge: JudgeClient = {
      model: 'gpt-5.4-mini',
      async complete() {
        throw new Error('no judge today');
      },
    };

    const result = await generateProductQueries(
      noCategory,
      [{ name: 'Presto X' }],
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(result.prompts.filter((p) => p.layer === 'visibility')).toEqual([]);
    expect(result.prompts.filter((p) => p.layer === 'reputation')).toHaveLength(
      1,
    );
    expect(result.notes.join(' ')).toContain('Presto X');
    expect(result.notes.join(' ')).toContain('descriptor');
  });
});
