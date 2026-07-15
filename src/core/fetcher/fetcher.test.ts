import { describe, expect, it, vi } from 'vitest';
import { createFetcher, type FetchLike, type HttpResponse } from './fetcher.js';

function res(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): HttpResponse {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (n) => lower.get(n.toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** A fake fetch routing exact URLs to responses (or thunks that may throw). */
function router(
  routes: Record<string, HttpResponse | (() => Promise<HttpResponse>)>,
): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return res(404);
    return typeof r === 'function' ? r() : r;
  };
  return { fn, calls };
}

describe('fetchUrl', () => {
  it('follows a redirect chain and reports the final URL and body', async () => {
    const { fn } = router({
      'https://a.example/': res(301, '', {
        location: 'https://a.example/next',
      }),
      'https://a.example/next': res(302, '', { location: '/final' }),
      'https://a.example/final': res(200, '<h1>hi</h1>', {
        'content-type': 'text/html',
      }),
    });
    const f = createFetcher({ fetchImpl: fn });
    const r = await f.fetchUrl('https://a.example/');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalUrl).toBe('https://a.example/final');
    expect(r.body).toBe('<h1>hi</h1>');
    expect(r.contentType).toBe('text/html');
  });

  it('returns a graceful error object for a 404 (never throws)', async () => {
    const { fn } = router({ 'https://a.example/x': res(404) });
    const f = createFetcher({ fetchImpl: fn });
    const r = await f.fetchUrl('https://a.example/x');
    expect(r).toMatchObject({ ok: false, status: 404, kind: 'http' });
  });

  it('truncates an oversized body and flags it', async () => {
    const { fn } = router({
      'https://a.example/big': res(200, 'x'.repeat(1000)),
    });
    const f = createFetcher({ fetchImpl: fn, maxBytes: 10 });
    const r = await f.fetchUrl('https://a.example/big');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('turns a thrown network error into a graceful failure object', async () => {
    const { fn } = router({
      'https://a.example/boom': () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const f = createFetcher({ fetchImpl: fn });
    const r = await f.fetchUrl('https://a.example/boom');
    expect(r).toMatchObject({ ok: false, kind: 'network' });
    if (r.ok) return;
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('caps redirects', async () => {
    const { fn } = router({
      'https://loop.example/': res(301, '', {
        location: 'https://loop.example/',
      }),
    });
    const f = createFetcher({ fetchImpl: fn, maxRedirects: 3 });
    const r = await f.fetchUrl('https://loop.example/');
    expect(r).toMatchObject({ ok: false, kind: 'too-many-redirects' });
  });

  it('sends an honest user-agent and caches by URL within a run', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const fn: FetchLike = vi.fn(async (_url, init) => {
      seen.push(init?.headers);
      return res(200, 'ok');
    });
    const f = createFetcher({
      fetchImpl: fn,
      userAgent: 'optifeed-visibility/9.9.9',
    });

    await f.fetchUrl('https://a.example/p');
    await f.fetchUrl('https://a.example/p'); // cached: no second call

    expect(fn).toHaveBeenCalledTimes(1);
    expect(seen[0]?.['user-agent']).toBe('optifeed-visibility/9.9.9');
  });
});

describe('fetchRobots / fetchLlmsTxt', () => {
  it('requests the well-known paths at the site origin', async () => {
    const { fn, calls } = router({
      'https://a.example/robots.txt': res(200, 'User-agent: *'),
      'https://a.example/llms.txt': res(200, '# llms'),
    });
    const f = createFetcher({ fetchImpl: fn });

    const robots = await f.fetchRobots('https://a.example/some/deep/page');
    const llms = await f.fetchLlmsTxt('https://a.example/');

    expect(robots.ok && robots.body).toBe('User-agent: *');
    expect(llms.ok && llms.body).toBe('# llms');
    expect(calls).toContain('https://a.example/robots.txt');
    expect(calls).toContain('https://a.example/llms.txt');
  });
});

describe('fetchSitemap', () => {
  const index = `<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://a.example/s1.xml</loc></sitemap>
      <sitemap><loc>https://a.example/s2.xml</loc></sitemap>
    </sitemapindex>`;
  const urlset = (locs: string[]) => `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}
    </urlset>`;

  it('recurses a sitemap index and caps the number of URLs', async () => {
    const { fn } = router({
      'https://a.example/sitemap.xml': res(200, index, {
        'content-type': 'application/xml',
      }),
      'https://a.example/s1.xml': res(200, urlset(['u1', 'u2', 'u3'])),
      'https://a.example/s2.xml': res(200, urlset(['u4', 'u5', 'u6'])),
    });
    const f = createFetcher({ fetchImpl: fn });
    const out = await f.fetchSitemap('https://a.example/sitemap.xml', {
      cap: 4,
    });

    expect(out.urls).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(out.truncated).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it('records a child sitemap failure and keeps going', async () => {
    const { fn } = router({
      'https://a.example/sitemap.xml': res(200, index),
      'https://a.example/s1.xml': res(200, urlset(['u1', 'u2'])),
      'https://a.example/s2.xml': res(500),
    });
    const f = createFetcher({ fetchImpl: fn });
    const out = await f.fetchSitemap('https://a.example/sitemap.xml', {
      cap: 50,
    });

    expect(out.urls).toEqual(['u1', 'u2']);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('s2.xml');
  });
});
