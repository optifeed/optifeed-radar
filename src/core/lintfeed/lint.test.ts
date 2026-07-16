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
    // one product, one gapped field (description) out of 8 scored fields.
    expect(report.feedScore).toBe(88);
    expect(report.readiness.find((r) => r.protocol === 'acp')?.verdict).toBe(
      'ready',
    );
  });
});

describe('lintFeedContent - failure modes', () => {
  it('surfaces malformed XML as parseErrors with an empty, not-ready report', () => {
    const report = lintFeedContent(fixture('malformed.xml'));
    expect(report.productCount).toBe(0);
    expect(report.parseErrors.length).toBeGreaterThan(0);
    expect(report.feedScore).toBe(0);
    for (const r of report.readiness) expect(r.verdict).toBe('not ready');
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
