/**
 * All outbound HTTP for site content in one place (M2).
 *
 * Everything returns graceful result objects - a failed fetch never throws a
 * raw network error upward (a site we cannot fetch is a finding, not a crash).
 * The `fetchImpl` is injectable so unit tests run with no network (hard rule #3).
 */
import * as cheerio from 'cheerio';

/** Minimal structural shape of a fetch response we depend on. */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injectable fetch. The global `fetch` is structurally compatible. */
export type FetchLike = (
  url: string,
  init?: {
    redirect?: 'manual' | 'follow';
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

export interface FetchOk {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  body: string;
  contentType: string | null;
  truncated: boolean;
}

export type FetchErrorKind =
  'http' | 'network' | 'timeout' | 'too-many-redirects';

export interface FetchErr {
  ok: false;
  url: string;
  status?: number;
  error: string;
  kind: FetchErrorKind;
}

export type FetchResult = FetchOk | FetchErr;

export interface SitemapResult {
  urls: string[];
  truncated: boolean;
  errors: string[];
}

export interface FetcherOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  timeoutMs?: number;
  /** Approximate max body size (UTF-16 length); oversized bodies are truncated. */
  maxBytes?: number;
  maxRedirects?: number;
}

export interface Fetcher {
  fetchUrl(url: string): Promise<FetchResult>;
  fetchRobots(siteUrl: string): Promise<FetchResult>;
  fetchLlmsTxt(siteUrl: string): Promise<FetchResult>;
  fetchSitemap(url: string, opts?: { cap?: number }): Promise<SitemapResult>;
}

const DEFAULTS = {
  userAgent: 'optifeed-visibility',
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxRedirects: 5,
};

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function originOf(siteUrl: string): string {
  return new URL(siteUrl).origin;
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const userAgent = options.userAgent ?? DEFAULTS.userAgent;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  // In-run cache keyed by requested URL.
  const cache = new Map<string, FetchResult>();

  async function once(current: string): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(current, {
        redirect: 'manual',
        headers: { 'user-agent': userAgent },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function doFetch(url: string): Promise<FetchResult> {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
      let response: HttpResponse;
      try {
        response = await once(current);
      } catch (err) {
        const aborted =
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError');
        return {
          ok: false,
          url,
          error: err instanceof Error ? err.message : String(err),
          kind: aborted ? 'timeout' : 'network',
        };
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return {
            ok: false,
            url,
            status: response.status,
            error: 'redirect without a location header',
            kind: 'http',
          };
        }
        current = new URL(location, current).toString();
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          url,
          status: response.status,
          error: `HTTP ${response.status}`,
          kind: 'http',
        };
      }

      const raw = await response.text();
      const truncated = raw.length > maxBytes;
      return {
        ok: true,
        url,
        finalUrl: current,
        status: response.status,
        body: truncated ? raw.slice(0, maxBytes) : raw,
        contentType: response.headers.get('content-type'),
        truncated,
      };
    }

    return {
      ok: false,
      url,
      error: `exceeded ${maxRedirects} redirects`,
      kind: 'too-many-redirects',
    };
  }

  async function fetchUrl(url: string): Promise<FetchResult> {
    const cached = cache.get(url);
    if (cached) return cached;
    const result = await doFetch(url);
    cache.set(url, result);
    return result;
  }

  async function fetchSitemap(
    url: string,
    opts: { cap?: number } = {},
  ): Promise<SitemapResult> {
    const cap = opts.cap ?? 50;
    const urls: string[] = [];
    const errors: string[] = [];
    const visited = new Set<string>();
    let truncated = false;

    async function walk(target: string): Promise<void> {
      if (urls.length >= cap) {
        truncated = true;
        return;
      }
      if (visited.has(target)) return;
      visited.add(target);

      const res = await fetchUrl(target);
      if (!res.ok) {
        errors.push(`${target}: ${res.error}`);
        return;
      }

      const $ = cheerio.load(res.body, { xmlMode: true });
      const locs = $('loc')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((l) => l.length > 0);

      if ($('sitemapindex').length > 0) {
        for (const child of locs) {
          if (urls.length >= cap) {
            truncated = true;
            break;
          }
          await walk(child);
        }
      } else {
        for (const loc of locs) {
          if (urls.length >= cap) {
            truncated = true;
            break;
          }
          urls.push(loc);
        }
      }
    }

    await walk(url);
    return { urls, truncated, errors };
  }

  return {
    fetchUrl,
    fetchRobots: (siteUrl) => fetchUrl(`${originOf(siteUrl)}/robots.txt`),
    fetchLlmsTxt: (siteUrl) => fetchUrl(`${originOf(siteUrl)}/llms.txt`),
    fetchSitemap,
  };
}
