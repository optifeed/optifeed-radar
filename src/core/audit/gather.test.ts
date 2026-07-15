import { describe, expect, it } from 'vitest';
import {
  createFetcher,
  type FetchLike,
  type HttpResponse,
} from '../fetcher/index.js';
import { gatherAuditInput } from './gather.js';

function res(status: number, body = ''): HttpResponse {
  return { status, headers: { get: () => null }, text: async () => body };
}

const homepageHtml = `<!doctype html><html lang="en"><head>
  <title>Acme</title><meta name="description" content="d" />
  <link rel="canonical" href="https://acme.example/" />
  <meta property="og:site_name" content="Acme" />
  <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
</head><body><h1>Acme</h1></body></html>`;

const sitemap = `<?xml version="1.0"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://acme.example/p1</loc></url>
    <url><loc>https://acme.example/p2</loc></url>
  </urlset>`;

const routes: Record<string, HttpResponse> = {
  'https://acme.example/robots.txt': res(200, 'User-agent: *\nDisallow:'),
  'https://acme.example/llms.txt': res(
    200,
    '# Acme\n- [x](https://acme.example/x)',
  ),
  'https://acme.example/llms-full.txt': res(404),
  'https://acme.example/': res(200, homepageHtml),
  'https://acme.example/sitemap.xml': res(200, sitemap),
  'https://acme.example/p1': res(200, '<html><body><h1>P1</h1></body></html>'),
  'https://acme.example/p2': res(200, '<html><body><h1>P2</h1></body></html>'),
};

const fetchImpl: FetchLike = async (url) => routes[url] ?? res(404);

describe('gatherAuditInput', () => {
  it('assembles audit inputs from a bare domain via the fetcher', async () => {
    const fetcher = createFetcher({ fetchImpl });
    const input = await gatherAuditInput('acme.example', fetcher, {
      samplePages: 2,
    });

    expect(input.domain).toBe('acme.example');
    expect(input.robotsTxt).toBe('User-agent: *\nDisallow:');
    expect(input.llmsTxt).toContain('Acme');
    expect(input.llmsFullTxt).toBeNull(); // 404 -> null
    expect(input.homepage?.title).toBe('Acme');
    expect(input.sitemap).toMatchObject({
      present: true,
      parseable: true,
      urlCount: 2,
    });
    // Homepage plus sampled sitemap pages.
    expect(input.sampledPages.length).toBeGreaterThanOrEqual(2);
  });

  it('reports nulls gracefully when the site cannot be fetched', async () => {
    const fetcher = createFetcher({ fetchImpl: async () => res(500) });
    const input = await gatherAuditInput('down.example', fetcher);

    expect(input.robotsTxt).toBeNull();
    expect(input.llmsTxt).toBeNull();
    expect(input.homepage).toBeNull();
    expect(input.sitemap).toMatchObject({ present: false });
  });
});
