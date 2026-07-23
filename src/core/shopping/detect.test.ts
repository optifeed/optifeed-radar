import { describe, expect, it } from 'vitest';
import type { EngineAnswer } from '../types.js';
import { analyzeProductAnswer, extractRecommendations } from './detect.js';

function answer(text: string, over: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt: 'best quiet home espresso machine',
    text,
    model: 'gpt-5.4-mini',
    costUsd: 0.001,
    ts: '2026-07-23T00:00:00.000Z',
    ...over,
  };
}

describe('extractRecommendations', () => {
  it('reads a numbered list with bold names and trailing blurbs', () => {
    const text = [
      'Here are my picks:',
      '',
      '1. **Breville Bambino Plus** - great value for a small kitchen',
      '2. **Gaggia Classic Pro**: a classic, very repairable',
      '3. Rancilio Silvia. A workhorse.',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([
      'Breville Bambino Plus',
      'Gaggia Classic Pro',
      'Rancilio Silvia',
    ]);
  });

  it('reads bulleted lists', () => {
    const text = [
      '- Aria 2 (quiet, compact)',
      '* Presto X',
      '• Brew Mini',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([
      'Aria 2',
      'Presto X',
      'Brew Mini',
    ]);
  });

  it('reads markdown headings and strips editorial labels', () => {
    const text = [
      '### Best overall: Breville Bambino Plus',
      'It heats fast.',
      '### Budget pick - Gaggia Classic Pro',
      'Cheaper.',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([
      'Breville Bambino Plus',
      'Gaggia Classic Pro',
    ]);
  });

  it('reads a bold lead-in paragraph with no list marker', () => {
    const text = '**Breville Bambino Plus** is the one to beat this year.';
    expect(extractRecommendations(text)).toEqual(['Breville Bambino Plus']);
  });

  it('de-dupes case-insensitively and keeps first-seen order', () => {
    const text = ['1. Aria 2', '2. Presto X', '3. aria 2'].join('\n');
    expect(extractRecommendations(text)).toEqual(['Aria 2', 'Presto X']);
  });

  it('skips section headings that are not products', () => {
    const text = [
      '## Conclusion',
      '1. **Aria 2** - the pick',
      '## Things to consider',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual(['Aria 2']);
  });

  it('returns nothing for prose with no list structure', () => {
    expect(
      extractRecommendations('It depends on your budget and taste.'),
    ).toEqual([]);
  });
});

describe('analyzeProductAnswer', () => {
  const shelfAnswer = answer(
    [
      '1. **Breville Bambino Plus** - great value',
      '2. **Aria II** - quiet and compact',
      '3. **Gaggia Classic Pro** - repairable',
    ].join('\n'),
  );

  it('matches the product through an alias and ranks it on the shelf', () => {
    const result = analyzeProductAnswer(shelfAnswer, {
      name: 'Aria 2',
      aliases: ['Aria II'],
    });
    expect(result.mentioned).toBe(true);
    expect(result.position).toBe(2);
    expect(result.shelf).toEqual([
      'Breville Bambino Plus',
      'Aria II',
      'Gaggia Classic Pro',
    ]);
    expect(result.product).toBe('Aria 2');
  });

  it('reports an absent product with the shelf that beat it', () => {
    const result = analyzeProductAnswer(shelfAnswer, { name: 'Presto X' });
    expect(result.mentioned).toBe(false);
    expect(result.position).toBeNull();
    expect(result.shelf).toHaveLength(3);
  });

  it('does not match a product name inside a longer word', () => {
    const result = analyzeProductAnswer(
      answer('The Ariana 5 is a fine machine.'),
      { name: 'Aria' },
    );
    expect(result.mentioned).toBe(false);
  });

  it('flags a mention with no parsed rank as ambiguous for the judge', () => {
    const result = analyzeProductAnswer(
      answer('Some people like the Aria 2, though it is not my first choice.'),
      { name: 'Aria 2' },
    );
    expect(result.mentioned).toBe(true);
    expect(result.position).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it('flags a single-word product name as ambiguous when matched', () => {
    const result = analyzeProductAnswer(
      answer('1. **Bambino** - great value\n2. **Silvia**'),
      { name: 'Bambino' },
    );
    expect(result.mentioned).toBe(true);
    expect(result.position).toBe(1);
    expect(result.ambiguous).toBe(true);
  });

  it('flags a long unstructured answer with no mention as ambiguous', () => {
    const prose = `Choosing depends on how much space you have and how much you want to spend. ${'Many buyers weigh milk texturing against footprint. '.repeat(4)}`;
    const result = analyzeProductAnswer(answer(prose), { name: 'Aria 2' });
    expect(result.mentioned).toBe(false);
    expect(result.shelf).toEqual([]);
    expect(result.ambiguous).toBe(true);
  });

  it('does not flag a short negative answer as ambiguous', () => {
    const result = analyzeProductAnswer(answer('It depends on your budget.'), {
      name: 'Aria 2',
    });
    expect(result.mentioned).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it('carries the engine, prompt and cited domains for scoring', () => {
    const result = analyzeProductAnswer(
      answer('1. **Aria 2** - the pick', {
        engine: 'perplexity',
        kind: 'grounded',
        citations: ['https://www.example.com/reviews/aria-2'],
      }),
      { name: 'Aria 2' },
    );
    expect(result.engine).toBe('perplexity');
    expect(result.prompt).toBe('best quiet home espresso machine');
    expect(result.citedDomains).toEqual(['example.com']);
  });
});
