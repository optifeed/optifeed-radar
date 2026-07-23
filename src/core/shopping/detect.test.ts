import { readFileSync } from 'node:fs';
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

/**
 * Real OpenAI answers captured from a live `shopping breville.com` run
 * (2026-07-23). Unit fixtures written by hand had every list item BE a product;
 * real answers bold the product and then bullet its FEATURES underneath, which
 * the first version of the parser happily read as more products ("Automatic
 * milk steaming with adjustable temp and texture" appeared on the shelf).
 */
const REAL_ANSWERS = JSON.parse(
  readFileSync(
    new URL(
      '../../../test/fixtures/shopping/real-answers.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as EngineAnswer[];

describe('extractRecommendations over real engine answers', () => {
  it('reads the products and not the feature bullets under them', () => {
    const withFeatureBullets = REAL_ANSWERS.find((a) =>
      a.text.includes('Automatic milk steaming'),
    )!;
    const shelf = extractRecommendations(withFeatureBullets.text);

    expect(shelf).toContain('Breville Bambino Plus');
    expect(shelf.some((s) => s.includes('Automatic milk steaming'))).toBe(
      false,
    );
    expect(shelf).not.toContain('Compact');
    expect(shelf).not.toContain('Downside');
    expect(shelf.some((s) => s.toLowerCase().startsWith('heats up'))).toBe(
      false,
    );
  });

  it('keeps real product names with punctuation and model codes', () => {
    const shelf = REAL_ANSWERS.flatMap((a) => extractRecommendations(a.text));
    expect(shelf).toContain('De’Longhi Dedica Arte');
    expect(shelf.some((s) => s.includes('Philips 3200/4300'))).toBe(true);
  });

  it('never returns a whole sentence as a product', () => {
    for (const answer of REAL_ANSWERS) {
      for (const name of extractRecommendations(answer.text)) {
        expect(name.split(/\s+/).length).toBeLessThanOrEqual(6);
      }
    }
  });

  it('scores the merchant product against the real shelf', () => {
    const answer = REAL_ANSWERS.find((a) =>
      a.text.includes('Automatic milk steaming'),
    )!;
    const result = analyzeProductAnswer(answer, { name: 'Bambino Plus' });
    expect(result.mentioned).toBe(true);
    expect(result.shelf.length).toBeGreaterThan(1);
    expect(result.shelf.length).toBeLessThan(8);
  });
});

describe('extractRecommendations rejects spec lines', () => {
  // Live, 2026-07-23: an answer comparing robot vacuums put "Height", "Corners",
  // "Bonus" and "Navigation" on a merchant's shelf as if they were rival
  // products. They are spec labels in a bulleted comparison.
  it('drops single-word spec labels from a comparison list', () => {
    const text = [
      '- Height: ~8.2 cm (one of the lowest)',
      '- Corners: good, especially with improved edge algorithms',
      '- Bonus: very good value for performance',
      '- Navigation: a slimmer sensor setup',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([]);
  });

  // Live, 2026-07-23: "**Best overall (reliable, great app, strong mapping)**"
  // put "reliable" on the shelf. The editorial-label split handed back whatever
  // followed the label without checking that it reads as a name.
  it('drops a spec word sitting behind an editorial label', () => {
    const text = [
      '**Best overall (reliable, great app, strong mapping)**',
      '**Best balance of size, speed, and quality**',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([]);
  });

  it('still takes the product from behind an editorial label', () => {
    const text =
      '- **Best budget: Gaggia Classic Pro**\n- Best overall: Aria 2';
    expect(extractRecommendations(text)).toEqual([
      'Gaggia Classic Pro',
      'Aria 2',
    ]);
  });

  it('drops a price range read as a name', () => {
    expect(extractRecommendations('- Around $700-$800 for this tier')).toEqual(
      [],
    );
  });

  it('still keeps a one-word product name when the answer bolds it', () => {
    const text = '1. **Bambino** - the compact pick\n2. **Silvia** - a classic';
    expect(extractRecommendations(text)).toEqual(['Bambino', 'Silvia']);
  });
});

describe('extractRecommendations rejects feature lines', () => {
  it('drops a bullet that reads as a sentence rather than a name', () => {
    const text = [
      '- Heats up in ~3 seconds (thermojet system)',
      '- Built-in grinder + auto milk steaming',
      '- One-touch drinks, quick startup',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([]);
  });

  it('drops a spec word standing on its own', () => {
    const text =
      '- Compact, reliable, and quiet\n- Touchscreen, guided workflow';
    expect(extractRecommendations(text)).toEqual([]);
  });

  it('keeps the bolded product names and not their feature bullets', () => {
    const text = [
      '**Breville Bambino Plus**',
      '- Probably the best pick',
      '- Fast heat up',
      '**Gaggia Classic Pro**',
      '- Cheaper option',
    ].join('\n');
    expect(extractRecommendations(text)).toEqual([
      'Breville Bambino Plus',
      'Gaggia Classic Pro',
    ]);
  });
});
