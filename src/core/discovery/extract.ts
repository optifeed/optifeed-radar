/**
 * Pure extraction of brand signals from fetched pages (M4).
 *
 * No network, no persistence, no LLM - just deterministic reading of the M2
 * {@link ExtractedPage} shapes. Competitor discovery (the one judge call) lives
 * in {@link ../competitors} and is never done here.
 */
import type { ExtractedPage } from '../fetcher/index.js';
import type { ProfileSources } from '../types.js';

/** What {@link extractSignals} pulls off the pages, with a source per field. */
export interface ExtractedSignals {
  brand: string;
  aliases: string[];
  category?: string;
  offerings?: string[];
  locale?: string;
  sources: ProfileSources;
}

/** Common second-level labels so `acme.co.uk` yields `acme`, not `co`. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/** The registrable-ish stem of a domain (e.g. `shop.acme.co.uk` -> `acme`). */
function domainStem(domain: string): string {
  const host = (domain.replace(/^https?:\/\//i, '').split('/')[0] ?? domain)
    .toLowerCase()
    .replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? host;
  let idx = labels.length - 2;
  if (idx > 0 && SECOND_LEVEL.has(labels[idx] ?? '')) idx -= 1;
  return labels[idx] ?? host;
}

function capitalize(word: string): string {
  return word.length === 0
    ? word
    : (word[0] ?? '').toUpperCase() + word.slice(1);
}

/** A best-effort brand name from the domain alone (the last-resort fallback). */
export function brandFromDomain(domain: string): string {
  return capitalize(domainStem(domain));
}

/**
 * Walk JSON-LD blocks (objects, bare arrays, and `@graph`) yielding every node
 * whose `@type` matches one of `wanted` (case-insensitive). Mirrors M3's walk.
 */
function* jsonLdNodes(
  pages: ExtractedPage[],
  wanted: string[],
): Generator<Record<string, unknown>> {
  const want = new Set(wanted.map((w) => w.toLowerCase()));
  const matched: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    const types = (Array.isArray(t) ? t : [t]).filter(
      (x): x is string => typeof x === 'string',
    );
    if (types.some((x) => want.has(x.toLowerCase()))) matched.push(obj);
    const graph = obj['@graph'];
    if (Array.isArray(graph)) graph.forEach(visit);
  };
  for (const p of pages) p.jsonLd.forEach(visit);
  yield* matched;
}

/** First non-empty string value under `key` across the given nodes. */
function firstString(
  nodes: Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const node of nodes) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** All string values under `key` (a value may itself be a string array). */
function allStrings(nodes: Record<string, unknown>[], key: string): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const v = node[key];
    for (const one of Array.isArray(v) ? v : [v]) {
      if (typeof one === 'string' && one.trim()) out.push(one.trim());
    }
  }
  return out;
}

/** Case-insensitive dedupe, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/** Extract deterministic brand signals from homepage + sampled pages. */
export function extractSignals(
  domain: string,
  pages: ExtractedPage[],
): ExtractedSignals {
  const orgs = [...jsonLdNodes(pages, ['Organization', 'WebSite'])];
  const products = [...jsonLdNodes(pages, ['Product'])];
  const sources: ExtractedSignals['sources'] = {};

  // Brand: og:site_name > JSON-LD Organization/WebSite name > domain stem.
  const siteNames = pages
    .map((p) => p.og.site_name?.trim())
    .filter((s): s is string => Boolean(s));
  const orgName = firstString(orgs, 'name');
  const stem = capitalize(domainStem(domain));
  const brand = siteNames[0] ?? orgName ?? stem;
  sources.brand = 'extracted';

  // Aliases: every other candidate name, deduped, brand removed.
  const aliases = dedupe([
    ...siteNames,
    ...(orgName ? [orgName] : []),
    ...allStrings(orgs, 'alternateName'),
    stem,
  ]).filter((a) => a.toLowerCase() !== brand.toLowerCase());
  sources.aliases = 'extracted';

  // Category: a short descriptor. Organization description > meta description.
  const category =
    firstString(orgs, 'description') ??
    pages.find((p) => p.metaDescription)?.metaDescription;
  if (category) sources.category = 'extracted';

  // Offerings: JSON-LD Product names (deduped).
  const offerings = dedupe(allStrings(products, 'name'));
  if (offerings.length > 0) sources.offerings = 'extracted';

  // Locale: <html lang> > og:locale > JSON-LD inLanguage.
  const locale =
    pages.find((p) => p.lang)?.lang ??
    pages.find((p) => p.og.locale)?.og.locale ??
    firstString(orgs, 'inLanguage');
  if (locale) sources.locale = 'extracted';

  return {
    brand,
    aliases,
    ...(category ? { category } : {}),
    ...(offerings.length > 0 ? { offerings } : {}),
    ...(locale ? { locale } : {}),
    sources,
  };
}
