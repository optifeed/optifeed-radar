import { describe, expect, it } from 'vitest';
import {
  buildShoppingEnvelope,
  type ShoppingEnvelope,
  type SkuReport,
} from '../shopping/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type ProductEntity,
} from '../types.js';
import { FOOTER_CTA } from './footer.js';
import {
  renderShoppingHtml,
  renderShoppingJson,
  renderShoppingText,
} from './render-shopping.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  competitors: [],
};

function answer(prompt: string): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt,
    text: '1. **Breville Bambino Plus**\n2. **Aria 2**',
    model: 'gpt-5.4-mini',
    costUsd: 0.001,
    ts: '2026-07-23T00:00:00.000Z',
  };
}

function sku(
  over: Partial<SkuReport> & { product: string; merchantRank: number },
): SkuReport {
  return {
    visibility: 40,
    engines: [
      {
        engine: 'openai',
        kind: 'parametric',
        score: 40,
        mentionRate: 0.5,
        avgPosition: 2,
        answers: 2,
        mentions: 1,
      },
    ],
    answers: 2,
    mentions: 1,
    avgPosition: 2,
    shelf: [
      {
        name: 'Breville Bambino Plus',
        isYours: false,
        mentions: 2,
        sharePct: 66.7,
      },
      { name: over.product, isYours: true, mentions: 1, sharePct: 33.3 },
    ],
    rows: [],
    reputationRows: [],
    ...over,
  };
}

/** The absent product: zero mentions, but a full shelf around it. */
const ABSENT = sku({
  product: 'Presto X',
  merchantRank: 1,
  visibility: 0,
  mentions: 0,
  avgPosition: null,
  engines: [
    {
      engine: 'openai',
      kind: 'parametric',
      score: 0,
      mentionRate: 0,
      avgPosition: null,
      answers: 3,
      mentions: 0,
    },
  ],
  answers: 3,
  shelf: [
    {
      name: 'Breville Bambino Plus',
      isYours: false,
      mentions: 6,
      sharePct: 60,
    },
    { name: 'Gaggia Classic Pro', isYours: false, mentions: 4, sharePct: 40 },
  ],
});

const PRESENT = sku({
  product: 'Aria 2',
  merchantRank: 2,
  reputation: { prompts: 1, answers: 2, positive: 1, neutral: 1, negative: 0 },
});

function envelope(
  over: Partial<Parameters<typeof buildShoppingEnvelope>[0]> = {},
): ShoppingEnvelope {
  return buildShoppingEnvelope({
    profile: PROFILE,
    products: [{ name: 'Presto X' }, { name: 'Aria 2' }] as ProductEntity[],
    skus: [ABSENT, PRESENT],
    answers: [answer('best espresso machine'), answer('is the Aria 2 good?')],
    rowsAnalyzed: 5,
    judged: 1,
    generatedAt: '2026-07-23T00:00:00.000Z',
    ...over,
  });
}

describe('renderShoppingText', () => {
  const text = renderShoppingText(envelope(), { color: false });

  it('leads with the ranking delta, before any product section', () => {
    const delta = text.indexOf('Your ranking');
    const firstProduct = text.indexOf('Presto X (your #1)');
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(firstProduct).toBeGreaterThan(delta);
  });

  it('shows where the engines put each product', () => {
    expect(text).toContain('Aria 2');
    // The merchant's #1 is never recommended; their #2 carries the shelf.
    expect(text).toMatch(/Presto X[^\n]*not recommended/);
    expect(text).toMatch(/Aria 2[^\n]*AI #1/);
  });

  it('leads an absent product with the shelf that beat it', () => {
    const section = text.slice(text.indexOf('Presto X (your #1)'));
    const shelf = section.indexOf('Breville Bambino Plus');
    const score = section.indexOf('Visibility:');
    expect(shelf).toBeGreaterThanOrEqual(0);
    expect(shelf).toBeLessThan(score);
    expect(section).toContain('engines recommended');
  });

  it('reports reputation apart from visibility', () => {
    expect(text).toContain('Reputation');
    expect(text).toContain('1 positive');
  });

  it('is honest about the sample and ends with the one footer CTA', () => {
    expect(text).toContain('estimates from a small sample');
    expect(text).toContain('2 engine answers');
    expect(text.trimEnd().endsWith(FOOTER_CTA)).toBe(true);
  });

  it('carries no ANSI when color is off and no em-dash ever', () => {
    expect(text).not.toContain('[');
    expect(text).not.toContain('—');
    expect(text).not.toContain('–');
  });

  it('surfaces run notes for a partial run', () => {
    const partial = renderShoppingText(
      envelope({
        honesty: {
          costCapped: true,
          skippedEngines: [{ engine: 'gemini', reason: 'no API key' }],
        },
      }),
      { color: false },
    );
    expect(partial).toContain('Run notes');
    expect(partial).toContain('Cost cap reached');
    expect(partial).toContain('gemini');
  });

  it('says when a product had no category questions at all', () => {
    const unmeasured = renderShoppingText(
      envelope({
        skus: [
          sku({
            product: 'Opaque',
            merchantRank: 1,
            visibility: null,
            answers: 0,
            mentions: 0,
            engines: [],
            shelf: [],
          }),
        ],
        products: [{ name: 'Opaque' }],
      }),
      { color: false },
    );
    expect(unmeasured).toContain('No category questions');
    expect(unmeasured).not.toContain('Visibility: 0/100');
  });
});

describe('renderShoppingJson', () => {
  it('is the envelope, parseable and free of ANSI', () => {
    const json = renderShoppingJson(envelope());
    expect(json).not.toContain('[');
    const parsed = JSON.parse(json) as ShoppingEnvelope;
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.rankingDelta).toHaveLength(2);
  });
});

describe('renderShoppingHtml', () => {
  const html = renderShoppingHtml(envelope());

  it('is one self-contained file with the delta table and the footer', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).toContain('Presto X');
    expect(html).toContain(FOOTER_CTA);
  });

  it('escapes untrusted product and shelf text', () => {
    const injected = renderShoppingHtml(
      envelope({
        skus: [sku({ product: '<img src=x onerror=1>', merchantRank: 1 })],
        products: [{ name: '<img src=x onerror=1>' }],
      }),
    );
    expect(injected).not.toContain('<img src=x');
    expect(injected).toContain('&lt;img src=x');
  });
});
