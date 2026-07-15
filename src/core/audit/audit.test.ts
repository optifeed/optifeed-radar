import { describe, expect, it } from 'vitest';
import type { ExtractedPage } from '../fetcher/index.js';
import { AUDIT_WEIGHTS, type AuditInput, buildAuditReport } from './audit.js';

const richPage: ExtractedPage = {
  title: 'Acme Espresso - Machines',
  metaDescription: 'Premium home espresso machines and grinders.',
  canonical: 'https://acme.example/',
  lang: 'en',
  h1: 'Espresso machines',
  og: { site_name: 'Acme Espresso', type: 'website' },
  jsonLd: [
    { '@type': 'Organization', name: 'Acme' },
    { '@type': 'WebSite', name: 'Acme' },
    { '@type': 'Product', name: 'Machine' },
  ],
  links: ['/products'],
};

/** A fully AI-ready site; scenarios below degrade one facet at a time. */
function perfectInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    domain: 'acme.example',
    robotsTxt: 'User-agent: *\nDisallow:',
    llmsTxt: '# Acme\n\n- [Docs](https://acme.example/docs)\n',
    llmsFullTxt: null,
    homepage: richPage,
    sampledPages: [richPage],
    sitemap: { present: true, parseable: true, urlCount: 12 },
    ...overrides,
  };
}

const severities = (r: ReturnType<typeof buildAuditReport>) =>
  r.findings.map((f) => f.severity);

describe('AUDIT_WEIGHTS', () => {
  it('sum to 100 (published weights)', () => {
    const total = AUDIT_WEIGHTS.reduce((s, c) => s + c.weight, 0);
    expect(total).toBe(100);
  });
});

describe('buildAuditReport', () => {
  it('scores a perfect site 100 with no warnings or errors', () => {
    const report = buildAuditReport(perfectInput());
    expect(report.score).toBe(100);
    expect(severities(report)).not.toContain('warn');
    expect(severities(report)).not.toContain('error');
    expect(report.domain).toBe('acme.example');
    expect(report.schema_version).toBeTruthy();
  });

  it('is deterministic (same input -> identical report)', () => {
    const input = perfectInput();
    expect(buildAuditReport(input)).toEqual(buildAuditReport(input));
  });

  it('always produces an integer score within 0..100', () => {
    for (const input of [
      perfectInput(),
      perfectInput({ robotsTxt: 'User-agent: *\nDisallow: /' }),
      perfectInput({ homepage: null, sampledPages: [], llmsTxt: null }),
    ]) {
      const { score } = buildAuditReport(input);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('sorts findings by severity, errors first', () => {
    const report = buildAuditReport(
      perfectInput({
        homepage: { og: {}, jsonLd: [], links: [] }, // missing title triggers error
        sampledPages: [],
        llmsTxt: null,
      }),
    );
    const rank = { error: 0, warn: 1, info: 2 } as const;
    const ranks = report.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  describe('scenario: robots blocks GPTBot', () => {
    it('drops the score and flags GPTBot as blocked', () => {
      const report = buildAuditReport(
        perfectInput({ robotsTxt: 'User-agent: GPTBot\nDisallow: /' }),
      );
      expect(report.score).toBeLessThan(100);
      const gptbot = report.bots.find((b) => b.bot === 'GPTBot');
      expect(gptbot?.access).toBe('blocked');
      const finding = report.findings.find((f) => f.message.includes('GPTBot'));
      expect(finding?.severity).toBe('warn');
    });
  });

  describe('scenario: no llms.txt', () => {
    it('flags the missing file', () => {
      const report = buildAuditReport(perfectInput({ llmsTxt: null }));
      expect(report.score).toBeLessThan(100);
      const finding = report.findings.find((f) =>
        f.message.toLowerCase().includes('llms.txt'),
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warn');
    });
  });

  describe('scenario: schema-less site', () => {
    it('flags the missing structured data', () => {
      const report = buildAuditReport(
        perfectInput({
          homepage: { ...richPage, jsonLd: [] },
          sampledPages: [{ ...richPage, jsonLd: [] }],
        }),
      );
      expect(report.score).toBeLessThan(100);
      const finding = report.findings.find((f) =>
        f.message.toLowerCase().includes('structured data'),
      );
      expect(finding?.severity).toBe('warn');
    });
  });
});
