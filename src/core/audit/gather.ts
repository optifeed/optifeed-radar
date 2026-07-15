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

  const robots = await fetcher.fetchRobots(origin);
  const llms = await fetcher.fetchLlmsTxt(origin);
  const llmsFull = await fetcher.fetchUrl(`${origin}/llms-full.txt`);
  const home = await fetcher.fetchUrl(`${origin}/`);

  const homepage = home.ok ? extractPage(home.body) : null;

  const sitemapUrl = `${origin}/sitemap.xml`;
  const sitemapRoot = await fetcher.fetchUrl(sitemapUrl);
  let sitemap: AuditInput['sitemap'] = {
    present: false,
    parseable: false,
    urlCount: 0,
  };
  const sampledPages = homepage ? [homepage] : [];

  if (sitemapRoot.ok) {
    const sm = await fetcher.fetchSitemap(sitemapUrl);
    sitemap = {
      present: true,
      parseable: sm.urls.length > 0,
      urlCount: sm.urls.length,
    };
    for (const url of sm.urls.slice(0, samplePages)) {
      const res = await fetcher.fetchUrl(url);
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
