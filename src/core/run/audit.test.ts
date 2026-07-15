import { describe, expect, it } from 'vitest';
import {
  createFetcher,
  type FetchLike,
  type HttpResponse,
} from '../fetcher/index.js';
import { runAudit } from './audit.js';

const res = (status: number, body = ''): HttpResponse => ({
  status,
  headers: { get: () => null },
  text: async () => body,
});

const routes: Record<string, HttpResponse> = {
  'https://acme.example/robots.txt': res(200, 'User-agent: *\nDisallow:'),
  'https://acme.example/llms.txt': res(
    200,
    '# Acme\n- [d](https://acme.example/d)',
  ),
  'https://acme.example/llms-full.txt': res(404),
  'https://acme.example/': res(
    200,
    `<!doctype html><html lang="en"><head>
       <title>Acme</title><meta name="description" content="d" />
       <link rel="canonical" href="https://acme.example/" />
       <meta property="og:site_name" content="Acme" />
       <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
       <script type="application/ld+json">{"@type":"WebSite","name":"Acme"}</script>
     </head><body><h1>Acme</h1></body></html>`,
  ),
  'https://acme.example/sitemap.xml': res(
    200,
    '<?xml version="1.0"?><urlset><url><loc>https://acme.example/p1</loc></url></urlset>',
  ),
  'https://acme.example/p1': res(200, '<html><body><h1>P1</h1></body></html>'),
};
const fetchImpl: FetchLike = async (url) => routes[url] ?? res(404);

describe('runAudit', () => {
  it('gathers inputs and returns a scored AuditReport for a domain', async () => {
    const report = await runAudit('acme.example', {
      fetcher: createFetcher({ fetchImpl }),
    });
    expect(report.domain).toBe('acme.example');
    expect(report.score).toBeGreaterThan(80);
    expect(report.bots.find((b) => b.bot === 'GPTBot')?.access).toBe('allowed');
  });

  it('degrades to a low score, no throw, when the site is unreachable', async () => {
    const report = await runAudit('down.example', {
      fetcher: createFetcher({ fetchImpl: async () => res(500) }),
    });
    expect(report.domain).toBe('down.example');
    expect(report.findings.some((f) => f.severity === 'error')).toBe(true);
  });
});
