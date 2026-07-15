/**
 * Assemble {@link AuditInput} for a domain using the M2 fetcher (M3).
 *
 * Thin gathering glue - it decides which URLs the audit needs and turns fetch
 * failures into nulls. The full check pipeline (M10) reuses this; the pure
 * scoring lives in {@link buildAuditReport}.
 */
import { type Fetcher, extractPage } from '../fetcher/index.js';
import type { AuditInput } from './audit.js';

/** Normalize a bare domain (or a full URL) into an origin URL. */
function toSiteUrl(domain: string): string {
  const withProto = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return new URL(withProto).origin;
}

export interface GatherOptions {
  /** How many sitemap pages to sample for structured-data richness (default 3). */
  samplePages?: number;
}

export async function gatherAuditInput(
  domain: string,
  fetcher: Fetcher,
  opts: GatherOptions = {},
): Promise<AuditInput> {
  const samplePages = opts.samplePages ?? 3;
  const origin = toSiteUrl(domain);
  const sitemapUrl = `${origin}/sitemap.xml`;

  // These five fetches are independent - run them concurrently.
  const [robots, llms, llmsFull, home, sitemapRoot] = await Promise.all([
    fetcher.fetchRobots(origin),
    fetcher.fetchLlmsTxt(origin),
    fetcher.fetchUrl(`${origin}/llms-full.txt`),
    fetcher.fetchUrl(`${origin}/`),
    fetcher.fetchUrl(sitemapUrl),
  ]);

  const homepage = home.ok ? extractPage(home.body) : null;
  const sampledPages = homepage ? [homepage] : [];

  let sitemap: AuditInput['sitemap'] = {
    present: false,
    parseable: false,
    urlCount: 0,
  };
  if (sitemapRoot.ok) {
    // Parseable = it actually looks like a sitemap. A valid but empty sitemap
    // (zero <loc>) is still parseable - url count alone must not decide this.
    const parseable = /<(urlset|sitemapindex)\b/i.test(sitemapRoot.body);
    const sm = await fetcher.fetchSitemap(sitemapUrl); // sitemapUrl is already cached
    sitemap = { present: true, parseable, urlCount: sm.urls.length };
    const sampled = await Promise.all(
      sm.urls.slice(0, samplePages).map((url) => fetcher.fetchUrl(url)),
    );
    for (const res of sampled) {
      if (res.ok) sampledPages.push(extractPage(res.body));
    }
  }

  return {
    domain,
    robotsTxt: robots.ok ? robots.body : null,
    llmsTxt: llms.ok ? llms.body : null,
    llmsFullTxt: llmsFull.ok ? llmsFull.body : null,
    homepage,
    sampledPages,
    sitemap,
  };
}
