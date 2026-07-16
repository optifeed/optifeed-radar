import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseFeed } from './parse.js';

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/lintfeed/${name}`, import.meta.url),
    'utf8',
  );

describe('detectFormat', () => {
  it('detects xml, json, and unknown by leading token', () => {
    expect(detectFormat('  <?xml version="1.0"?><rss></rss>')).toBe('xml');
    expect(detectFormat('\n[ {"a": 1} ]')).toBe('json');
    expect(detectFormat('{"products": []}')).toBe('json');
    expect(detectFormat('a,b,c\n1,2,3')).toBe('unknown');
  });
});

describe('parseFeed - Google Shopping XML', () => {
  it('extracts every product with mapped fields and parsed price currency', () => {
    const { products, format, parseErrors } = parseFeed(fixture('clean.xml'));
    expect(format).toBe('xml');
    expect(parseErrors).toEqual([]);
    expect(products).toHaveLength(2);

    const p = products[0]!;
    expect(p.id).toBe('SKU1');
    expect(p.title).toBe('Acme Beginner Rocket Kit');
    expect(p.brand).toBe('Acme');
    expect(p.gtin).toBe('00012345678905');
    expect(p.mpn).toBe('ACME-001');
    expect(p.imageUrl).toBe('https://acme.example/img/1.jpg');
    expect(p.url).toBe('https://acme.example/p/1');
    // "29.99 USD" splits into a numeric price and an ISO 4217 currency.
    expect(p.price).toBe('29.99');
    expect(p.currency).toBe('USD');
    expect(p.availability).toBe('in stock');
    // raw keeps every field for extra rules/evidence.
    expect(p.raw.brand).toBe('Acme');
  });
});

describe('parseFeed - ACP JSON', () => {
  it('maps the flat ACP field names (item_id, image_url) into the product', () => {
    const { products, format, parseErrors } = parseFeed(fixture('clean.json'));
    expect(format).toBe('json');
    expect(parseErrors).toEqual([]);
    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.id).toBe('SKU1');
    expect(p.imageUrl).toBe('https://acme.example/img/1.jpg');
    expect(p.currency).toBe('USD');
    expect(p.availability).toBe('in_stock');
  });

  it('recognizes a capitalized/alternate wrapper key (Products/items/entries)', () => {
    const wrapped = '{"Products": [ {"item_id": "X", "title": "Widget"} ]}';
    const { products, parseErrors } = parseFeed(wrapped);
    expect(parseErrors).toEqual([]);
    expect(products).toHaveLength(1);
    expect(products[0]!.id).toBe('X');
  });
});

describe('parseFeed - failure modes (never throws)', () => {
  it('surfaces malformed XML as a parse error with zero products', () => {
    const result = parseFeed(fixture('malformed.xml'));
    expect(result.products).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it('surfaces invalid JSON as a parse error, not a throw', () => {
    const result = parseFeed('[ { not json ');
    expect(result.products).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });

  it('reports an unsupported (CSV/TSV) format without throwing', () => {
    const result = parseFeed('id,title,price\n1,Widget,9.99');
    expect(result.format).toBe('unknown');
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.products).toEqual([]);
  });
});
