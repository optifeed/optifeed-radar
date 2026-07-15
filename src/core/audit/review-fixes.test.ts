import { describe, expect, it } from 'vitest';
import {
  createFetcher,
  type ExtractedPage,
  type FetchLike,
  type HttpResponse,
} from '../fetcher/index.js';
import { type AuditInput, buildAuditReport } from './audit.js';
import { gatherAuditInput } from './gather.js';

const richPage: ExtractedPage = {
  title: 'Acme',
  metaDescription: 'd',
  canonical: 'https://a.example/',
  lang: 'en',
  h1: 'Acme',
  og: { site_name: 'Acme' },
  jsonLd: [{ '@type': 'Organization' }, { '@type': 'WebSite' }],
  links: [],
};

function baseInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    domain: 'a.example',
    robotsTxt: 'User-agent: *\nDisallow:',
    llmsTxt: '# Acme\n- [x](https://a.example/x)',
    llmsFullTxt: null,
    homepage: richPage,
    sampledPages: [richPage],
    sitemap: { present: true, parseable: true, urlCount: 3 },
    ...overrides,
  };
}

// Finding 3
describe('array-form JSON-LD', () => {
  it('reads @type from a top-level JSON-LD array', () => {
    const page: ExtractedPage = {
      ...richPage,
      jsonLd: [[{ '@type': 'Organization' }, { '@type': 'WebSite' }]],
    };
    const report = buildAuditReport(
      baseInput({ homepage: page, sampledPages: [page] }),
    );
    expect(
      report.findings.some((f) => f.id === 'structured.organization'),
    ).toBe(false);
    expect(report.findings.some((f) => f.id === 'structured.website')).toBe(
      false,
    );
    expect(report.score).toBe(100);
  });
});

// Finding 9
describe('llms-full.txt', () => {
  it('is noted as a positive signal when present', () => {
    const withFull = buildAuditReport(
      baseInput({ llmsFullTxt: '# full\n- [x](https://a.example/x)' }),
    );
    expect(withFull.findings.some((f) => f.id === 'llms.full')).toBe(true);
  });
  it('produces no llms-full finding when absent', () => {
    const withoutFull = buildAuditReport(baseInput({ llmsFullTxt: null }));
    expect(withoutFull.findings.some((f) => f.id === 'llms.full')).toBe(false);
  });
});

// Finding 4
describe('gatherAuditInput empty sitemap', () => {
  it('treats a valid but empty sitemap as parseable', async () => {
    const emptySitemap =
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
    const res = (status: number, body = ''): HttpResponse => ({
      status,
      headers: { get: () => null },
      text: async () => body,
    });
    const routes: Record<string, HttpResponse> = {
      'https://a.example/robots.txt': res(200, 'User-agent: *\nDisallow:'),
      'https://a.example/llms.txt': res(404),
      'https://a.example/llms-full.txt': res(404),
      'https://a.example/': res(
        200,
        '<html><head><title>a</title></head></html>',
      ),
      'https://a.example/sitemap.xml': res(200, emptySitemap),
    };
    const fetchImpl: FetchLike = async (url) => routes[url] ?? res(404);
    const input = await gatherAuditInput(
      'a.example',
      createFetcher({ fetchImpl }),
    );

    expect(input.sitemap).toMatchObject({
      present: true,
      parseable: true,
      urlCount: 0,
    });
  });
});
