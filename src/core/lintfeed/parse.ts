/**
 * Parse a product feed into normalized {@link FeedProduct}s (M14). Supports
 * Google Shopping XML (RSS 2.0 with the `g:` namespace) and flat ACP-style
 * JSON. Never throws - malformed input and unsupported formats are surfaced as
 * `parseErrors` (hard rule #3, and the graceful-failure contract). CSV/TSV are
 * a documented follow-up (report an honest error rather than pretend support).
 */
import * as cheerio from 'cheerio';
import type { FeedProduct } from '../types.js';

/** The feed format detected from a document's leading token. */
export type FeedFormat = 'xml' | 'json' | 'csv' | 'tsv' | 'unknown';

export interface ParseResult {
  products: FeedProduct[];
  format: FeedFormat;
  parseErrors: string[];
}

/** Detect the feed format from the first non-whitespace character. */
export function detectFormat(content: string): FeedFormat {
  const t = content.trimStart();
  if (t.startsWith('<')) return 'xml';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  return 'unknown';
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/** Map a raw feed record's keys onto the typed {@link FeedProduct} fields. */
function normalize(raw: Record<string, string>): FeedProduct {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  const product: FeedProduct = { raw };
  const assign = (key: keyof FeedProduct, value: string | undefined): void => {
    if (value !== undefined) {
      (product as unknown as Record<string, unknown>)[key] = value;
    }
  };

  assign('id', get('id', 'item_id', 'sku', 'offer_id'));
  assign('title', get('title'));
  assign('description', get('description'));
  assign('brand', get('brand'));
  assign('gtin', get('gtin', 'barcode', 'upc'));
  assign('mpn', get('mpn'));
  assign('imageUrl', get('image_url', 'image_link', 'imageurl'));
  assign('url', get('url', 'link'));
  assign('availability', get('availability'));

  // Price may be authored as "29.99 USD" (Google) or a bare number with a
  // separate currency field (ACP JSON). Split a trailing 3-letter currency out.
  const rawPrice = get('price');
  const currency = get('currency');
  if (rawPrice !== undefined) {
    // Google authors "29.99 USD"; split a trailing 3-letter currency token off.
    const tokens = rawPrice.trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (tokens.length >= 2 && last && CURRENCY_CODE.test(last)) {
      assign('price', tokens.slice(0, -1).join(' '));
      assign('currency', last.toUpperCase());
    } else {
      assign('price', rawPrice.trim());
    }
  }
  if (currency !== undefined && product.currency === undefined) {
    assign('currency', currency.toUpperCase());
  }

  return product;
}

/** Strip a namespace prefix (`g:gtin` -> `gtin`) and lower-case a tag name. */
function localName(tag: string): string {
  const colon = tag.indexOf(':');
  return (colon >= 0 ? tag.slice(colon + 1) : tag).toLowerCase();
}

function parseXml(content: string): ParseResult {
  // cheerio/htmlparser2 is lenient and does not throw on malformed XML - it
  // parses what it can, so malformed input falls through to the "no items"
  // branch below rather than being caught here (no dead try/catch).
  const $ = cheerio.load(content, { xmlMode: true });

  // RSS uses <item>; Atom uses <entry>. Read each element's children generically
  // so namespaced tags need no selector escaping and every field lands in raw.
  const items = $('item').length ? $('item') : $('entry');
  if (items.length === 0) {
    return {
      products: [],
      format: 'xml',
      parseErrors: [
        'No <item> or <entry> elements found - not a recognized Google Shopping (RSS) or Atom feed, or the XML is malformed.',
      ],
    };
  }

  const products: FeedProduct[] = [];
  items.each((_, item) => {
    const raw: Record<string, string> = {};
    $(item)
      .children()
      .each((__, child) => {
        const el = child as { tagName?: string; name?: string };
        const tag = el.tagName ?? el.name;
        if (!tag) return;
        const text = $(child).text().trim();
        if (text) raw[localName(tag)] = text;
      });
    products.push(normalize(raw));
  });
  return { products, format: 'xml', parseErrors: [] };
}

const WRAPPER_KEYS = new Set(['products', 'items', 'entries']);

/** Find the product array under a known wrapper key, matched case-insensitively. */
function wrappedArray(parsed: unknown): unknown[] | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (WRAPPER_KEYS.has(key.toLowerCase()) && Array.isArray(value)) {
      return value as unknown[];
    }
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function parseJson(content: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      products: [],
      format: 'json',
      parseErrors: [
        `Could not parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // Accept a bare array, or an object wrapping the products under a known key
  // matched case-insensitively (a feed may serve `Products`, `Items`, etc.).
  const list = Array.isArray(parsed) ? parsed : wrappedArray(parsed);
  if (!Array.isArray(list)) {
    return {
      products: [],
      format: 'json',
      parseErrors: [
        'JSON feed is not a product array or an object with a `products`/`items` array.',
      ],
    };
  }

  const products = list.map((entry) => {
    const raw: Record<string, string> = {};
    if (entry && typeof entry === 'object') {
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        const s = stringField(v);
        if (s !== undefined) raw[k.toLowerCase()] = s;
      }
    }
    return normalize(raw);
  });
  return { products, format: 'json', parseErrors: [] };
}

/**
 * Parse feed `content`, auto-detecting the format unless `format` is given.
 * Always returns a result - failures populate `parseErrors`, never throw.
 */
export function parseFeed(content: string, format?: FeedFormat): ParseResult {
  const fmt = format ?? detectFormat(content);
  switch (fmt) {
    case 'xml':
      return parseXml(content);
    case 'json':
      return parseJson(content);
    default:
      return {
        products: [],
        format: fmt,
        parseErrors: [
          `Unsupported feed format: ${fmt}. lint-feed currently parses XML (Google Shopping RSS) and JSON; CSV/TSV support is a follow-up.`,
        ],
      };
  }
}
