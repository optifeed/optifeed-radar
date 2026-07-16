import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type FeedLintReport } from '../types.js';
import { FOOTER_CTA } from './footer.js';
import { renderFeedLintJson, renderFeedLintText } from './render-lintfeed.js';

function report(over: Partial<FeedLintReport> = {}): FeedLintReport {
  return {
    schema_version: SCHEMA_VERSION,
    source: 'https://acme.example/feed.xml',
    format: 'xml',
    productCount: 3,
    products: [
      {
        sku: 'SKU-1',
        findings: [
          {
            ruleId: 'brand.missing',
            protocol: 'acp',
            severity: 'error',
            field: 'brand',
            message: 'Missing brand.',
            docsUrl: 'https://example.com/acp#brand',
            sku: 'SKU-1',
          },
          {
            ruleId: 'description.thin',
            protocol: 'acp',
            severity: 'warn',
            field: 'description',
            message: 'Description is too thin for AI agents to use.',
            docsUrl: 'https://example.com/acp#description',
            sku: 'SKU-1',
          },
        ],
      },
    ],
    summary: { error: 1, warn: 1, info: 0 },
    feedScore: 78,
    readiness: [{ protocol: 'acp', score: 67, verdict: 'nearly ready' }],
    parseErrors: [],
    ...over,
  };
}

describe('renderFeedLintText', () => {
  it('reports the feed score, format, and product count', () => {
    const out = renderFeedLintText(report(), { color: false });
    expect(out).toContain('78/100');
    expect(out).toContain('xml');
    expect(out).toContain('3');
  });

  it('groups findings under their SKU with a severity tag', () => {
    const out = renderFeedLintText(report(), { color: false });
    expect(out).toContain('SKU-1');
    expect(out).toContain('[fail]');
    expect(out).toContain('Missing brand.');
    expect(out).toContain('[warn]');
    expect(out).toContain('Description is too thin for AI agents to use.');
  });

  it('shows the per-protocol readiness verdict', () => {
    const out = renderFeedLintText(report(), { color: false });
    expect(out).toContain('acp');
    expect(out).toContain('nearly ready');
  });

  it('says "not assessed" rather than a fabricated 0 when nothing parsed', () => {
    const out = renderFeedLintText(
      report({
        productCount: 0,
        products: [],
        summary: { error: 0, warn: 0, info: 0 },
        feedScore: null,
        readiness: [{ protocol: 'acp', score: null, verdict: 'not assessed' }],
        format: 'unknown',
        parseErrors: ['Could not parse the feed: malformed XML.'],
      }),
      { color: false },
    );
    expect(out).toContain('not assessed');
    expect(out).not.toContain('0/100');
  });

  it('pluralizes an advisory count grammatically', () => {
    const out = renderFeedLintText(
      report({ summary: { error: 0, warn: 0, info: 2 } }),
      { color: false },
    );
    expect(out).toContain('2 advisories');
    expect(out).not.toContain('advisorys');
  });

  it('does not claim "no findings" over a feed it never assessed', () => {
    const out = renderFeedLintText(
      report({
        productCount: 0,
        products: [],
        summary: { error: 0, warn: 0, info: 0 },
        feedScore: null,
        readiness: [{ protocol: 'acp', score: null, verdict: 'not assessed' }],
        parseErrors: ['Could not parse the feed: malformed XML.'],
      }),
      { color: false },
    );
    expect(out.toLowerCase()).not.toContain('no findings');
  });

  it('states an unassessed readiness verdict once, without a duplicate score', () => {
    const out = renderFeedLintText(
      report({
        feedScore: null,
        readiness: [{ protocol: 'acp', score: null, verdict: 'not assessed' }],
      }),
      { color: false },
    );
    expect(out).not.toContain('not assessed (not assessed)');
  });

  it('surfaces parse errors as notes (never hidden)', () => {
    const out = renderFeedLintText(
      report({ parseErrors: ['Feed was truncated at the fetch size cap.'] }),
      { color: false },
    );
    expect(out).toContain('Feed was truncated at the fetch size cap.');
  });

  it('reports a clean feed honestly instead of listing nothing', () => {
    const out = renderFeedLintText(
      report({
        products: [],
        summary: { error: 0, warn: 0, info: 0 },
        feedScore: 100,
        readiness: [{ protocol: 'acp', score: 100, verdict: 'ready' }],
      }),
      { color: false },
    );
    expect(out.toLowerCase()).toContain('no findings');
  });

  it('ends with the single footer CTA and no em-dash', () => {
    const out = renderFeedLintText(report(), { color: false });
    expect(out.trimEnd().endsWith(FOOTER_CTA)).toBe(true);
    expect(out).not.toContain('—');
  });

  it('emits ANSI-free output when color is off', () => {
    const out = renderFeedLintText(report(), { color: false });
    expect(out.includes('\u001b[')).toBe(false);
  });
});

describe('renderFeedLintJson', () => {
  it('emits the raw report carrying schema_version', () => {
    const parsed = JSON.parse(renderFeedLintJson(report()));
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.feedScore).toBe(78);
    expect(parsed.readiness[0].protocol).toBe('acp');
  });
});
