import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../types.js';
import { lintFeedContent } from './lint.js';

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/lintfeed/${name}`, import.meta.url),
    'utf8',
  );

describe('lintFeedContent - clean feed', () => {
  it('scores a clean feed 100 with no error/warn findings and both protocols ready', () => {
    const report = lintFeedContent(fixture('clean.xml'), { source: 'clean' });
    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(report.format).toBe('xml');
    expect(report.productCount).toBe(2);
    expect(report.summary.error).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.feedScore).toBe(100);
    for (const r of report.readiness) expect(r.verdict).toBe('ready');
    // Readiness is only reported for protocols with protocol-specific rules.
    // No UCP-specific rules exist yet, so UCP is not claimed as checked (rule #6).
    expect(report.readiness.map((r) => r.protocol)).toEqual(['acp']);
  });
});

describe('lintFeedContent - missing GTIN is advisory only', () => {
  it('emits a gtin.missing info finding but does NOT lower the score or block readiness', () => {
    const report = lintFeedContent(fixture('missing-gtin.xml'));
    const findings = report.products.flatMap((p) => p.findings);
    expect(findings.some((f) => f.ruleId === 'gtin.missing')).toBe(true);
    expect(findings.find((f) => f.ruleId === 'gtin.missing')?.severity).toBe(
      'info',
    );
    // GTIN is optional in ACP - an advisory must not tank the feed.
    expect(report.summary.error).toBe(0);
    expect(report.feedScore).toBe(100);
    expect(report.readiness.find((r) => r.protocol === 'acp')?.verdict).toBe(
      'ready',
    );
  });
});

describe('lintFeedContent - thin description', () => {
  it('warns and lowers the graded score, but stays error-free (still ready)', () => {
    const report = lintFeedContent(fixture('thin-desc.xml'));
    const findings = report.products.flatMap((p) => p.findings);
    expect(findings.some((f) => f.ruleId === 'description.thin')).toBe(true);
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.summary.error).toBe(0);
    // one product, one gapped field (description) out of 8 scored fields:
    // floor(100 * (1 - 1/8)) = floor(87.5) = 87 (floored so <100 is never
    // rounded up to a perfect-looking score).
    expect(report.feedScore).toBe(87);
    expect(report.readiness.find((r) => r.protocol === 'acp')?.verdict).toBe(
      'ready',
    );
  });
});

describe('lintFeedContent - honest rounding (no round-up to perfect)', () => {
  it('keeps readiness below "ready" when any product has a blocking error', () => {
    // 199 clean products + 1 missing a title. 100*199/200 = 99.5 would round to
    // 100 ("ready"); flooring keeps it 99 so a real error is never laundered.
    const products = Array.from({ length: 200 }, (_, i) => ({
      item_id: `SKU${i}`,
      title: i === 0 ? '' : 'Acme Rocket Kit',
      description: 'A complete beginner rocket kit with everything included.',
      brand: 'Acme',
      image_url: 'https://acme.example/i.jpg',
      url: 'https://acme.example/p',
      gtin: '00012345678905',
      price: '29.99',
      currency: 'USD',
      availability: 'in_stock',
    }));
    const report = lintFeedContent(JSON.stringify(products));
    const acp = report.readiness.find((r) => r.protocol === 'acp')!;
    expect(acp.score).toBe(99);
    expect(acp.verdict).not.toBe('ready');
  });
});

describe('lintFeedContent - failure modes', () => {
  it('surfaces malformed XML as parseErrors with an empty, not-ready report', () => {
    const report = lintFeedContent(fixture('malformed.xml'));
    expect(report.productCount).toBe(0);
    expect(report.parseErrors.length).toBeGreaterThan(0);
    // Not evaluated -> null score + "not assessed", never a fabricated 0 (rule #6).
    expect(report.feedScore).toBeNull();
    for (const r of report.readiness) {
      expect(r.score).toBeNull();
      expect(r.verdict).toBe('not assessed');
    }
  });

  it('flags missing required fields as errors that block ACP readiness', () => {
    // A JSON product with no title and no price (both required).
    const report = lintFeedContent(
      JSON.stringify([
        {
          item_id: 'X',
          brand: 'Acme',
          image_url: 'https://x/i.jpg',
          description: 'A perfectly adequate description here.',
          gtin: '00012345678905',
          price: '',
          availability: 'in_stock',
        },
      ]),
    );
    const errors = report.products
      .flatMap((p) => p.findings)
      .filter((f) => f.severity === 'error');
    expect(errors.map((e) => e.ruleId)).toContain('title.missing');
    expect(errors.map((e) => e.ruleId)).toContain('price.missing');
    expect(report.readiness.find((r) => r.protocol === 'acp')?.verdict).toBe(
      'not ready',
    );
  });
});
