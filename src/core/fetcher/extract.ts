/**
 * Pure HTML extraction via cheerio (M2). No network, no throwing on bad input -
 * cheerio is lenient and missing fields come back empty/undefined.
 */
import * as cheerio from 'cheerio';

export interface ExtractedPage {
  title?: string;
  metaDescription?: string;
  canonical?: string;
  lang?: string;
  h1?: string;
  /** Open Graph properties keyed without the `og:` prefix (e.g. `site_name`). */
  og: Record<string, string>;
  /** Parsed JSON-LD blocks; invalid blocks are skipped. */
  jsonLd: unknown[];
  /** Anchor hrefs as authored (resolution against the base URL is the caller's job). */
  links: string[];
}

function textOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractPage(html: string): ExtractedPage {
  const $ = cheerio.load(html);

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const property = $(el).attr('property');
    const content = $(el).attr('content');
    if (property && content) {
      og[property.slice('og:'.length)] = content;
    }
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw.trim()) return;
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // Invalid JSON-LD is a finding for M3, not a crash here.
    }
  });

  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });

  return {
    title: textOrUndefined($('head > title').first().text()),
    metaDescription: textOrUndefined(
      $('meta[name="description"]').attr('content'),
    ),
    canonical: textOrUndefined($('link[rel="canonical"]').attr('href')),
    lang: textOrUndefined($('html').attr('lang')),
    h1: textOrUndefined($('h1').first().text()),
    og,
    jsonLd,
    links,
  };
}
