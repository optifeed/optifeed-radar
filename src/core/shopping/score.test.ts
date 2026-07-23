import { describe, expect, it } from 'vitest';
import type { EngineAnswer, EngineId } from '../types.js';
import { analyzeProductAnswer } from './detect.js';
import { scoreProduct } from './score.js';

function answer(
  text: string,
  engine: EngineId = 'openai',
  prompt = 'best quiet home espresso machine',
): EngineAnswer {
  return {
    engine,
    kind: 'parametric',
    prompt,
    text,
    model: 'gpt-5.4-mini',
    costUsd: 0.001,
    ts: '2026-07-23T00:00:00.000Z',
  };
}

const SHELF = [
  '1. **Breville Bambino Plus** - great value',
  '2. **Gaggia Classic Pro** - repairable',
  '3. **Rancilio Silvia**',
].join('\n');

const WITH_ARIA = [
  '1. **Aria II** - quiet and compact',
  '2. **Breville Bambino Plus**',
].join('\n');

function rows(
  texts: { text: string; engine?: EngineId; prompt?: string }[],
  product: { name: string; aliases?: string[] },
) {
  return texts.map((t) => {
    const a = answer(t.text, t.engine, t.prompt);
    return { answer: a, result: analyzeProductAnswer(a, product) };
  });
}

const ARIA = { name: 'Aria 2', aliases: ['Aria II'] };

describe('scoreProduct', () => {
  it('scores the visibility layer per engine and overall', () => {
    const report = scoreProduct({
      product: ARIA,
      merchantRank: 1,
      categoryPrompts: 2,
      visibility: rows(
        [
          { text: WITH_ARIA, engine: 'openai' },
          { text: SHELF, engine: 'anthropic' },
        ],
        ARIA,
      ),
      reputation: [],
      owners: [ARIA],
    });

    expect(report.product).toBe('Aria 2');
    expect(report.merchantRank).toBe(1);
    expect(report.answers).toBe(2);
    expect(report.mentions).toBe(1);
    expect(report.engines.map((e) => e.engine)).toEqual([
      'openai',
      'anthropic',
    ]);
    expect(report.engines[0]?.mentions).toBe(1);
    expect(report.engines[1]?.mentions).toBe(0);
    expect(report.visibility).toBeGreaterThan(0);
    expect(report.avgPosition).toBe(1);
  });

  it('gives an absent product a populated shelf, never a bare zero', () => {
    const report = scoreProduct({
      product: { name: 'Presto X' },
      merchantRank: 2,
      categoryPrompts: 2,
      visibility: rows(
        [
          { text: SHELF, engine: 'openai' },
          { text: SHELF, engine: 'anthropic' },
        ],
        { name: 'Presto X' },
      ),
      reputation: [],
      owners: [{ name: 'Presto X' }],
    });

    expect(report.mentions).toBe(0);
    expect(report.shelf.length).toBeGreaterThan(0);
    expect(report.shelf[0]).toMatchObject({
      name: 'Breville Bambino Plus',
      mentions: 2,
      isYours: false,
    });
    const total = report.shelf.reduce((sum, row) => sum + row.sharePct, 0);
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThan(101);
  });

  it('reports the shelf under the merchant name and marks what is theirs', () => {
    const report = scoreProduct({
      product: ARIA,
      merchantRank: 1,
      categoryPrompts: 1,
      visibility: rows([{ text: WITH_ARIA }], ARIA),
      reputation: [],
      owners: [ARIA],
    });

    const yours = report.shelf.find((row) => row.isYours);
    expect(yours?.name).toBe('Aria 2');
    expect(report.shelf.some((row) => row.name === 'Aria II')).toBe(false);
  });

  it('counts reputation only from the product-named layer', () => {
    const named = rows(
      [
        {
          text: 'The Aria 2 is an excellent, reliable machine that we recommend.',
          prompt: 'is the Aria 2 worth it?',
        },
      ],
      ARIA,
    );
    const report = scoreProduct({
      product: ARIA,
      merchantRank: 1,
      categoryPrompts: 1,
      visibility: rows([{ text: WITH_ARIA }], ARIA),
      reputation: named,
      owners: [ARIA],
    });

    expect(report.reputation).toEqual({
      prompts: 1,
      answers: 1,
      positive: 1,
      neutral: 0,
      negative: 0,
    });
    // The visibility answer must not leak into the reputation counts.
    expect(report.answers).toBe(1);
  });

  it('reports no visibility score when the category layer was never asked', () => {
    const report = scoreProduct({
      product: { name: 'Presto X' },
      merchantRank: 2,
      categoryPrompts: 0,
      visibility: [],
      reputation: rows(
        [
          {
            text: 'The Presto X is fine.',
            prompt: 'is the Presto X worth it?',
          },
        ],
        { name: 'Presto X' },
      ),
      owners: [{ name: 'Presto X' }],
    });

    expect(report.visibility).toBeNull();
    expect(report.answers).toBe(0);
    expect(report.shelf).toEqual([]);
    expect(report.reputation?.answers).toBe(1);
  });
});
