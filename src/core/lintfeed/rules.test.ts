import { describe, expect, it } from 'vitest';
import type { FeedProduct } from '../types.js';
import { LINT_RULES } from './rules.js';

function product(over: Partial<FeedProduct> = {}): FeedProduct {
  return { raw: {}, ...over };
}

const rule = (id: string) => {
  const r = LINT_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
};

describe('LINT_RULES table', () => {
  it('is a non-empty table with unique ids and complete metadata', () => {
    expect(LINT_RULES.length).toBeGreaterThan(8);
    const ids = LINT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const r of LINT_RULES) {
      expect(r.protocol).toMatch(/^(acp|ucp|both)$/);
      expect(r.severity).toMatch(/^(error|warn|info)$/);
      expect(r.field).toBeTruthy();
      expect(r.message).toBeTruthy();
      expect(r.docsUrl).toMatch(/^https?:\/\//);
      expect(typeof r.violated).toBe('function');
    }
  });
});

describe('required-field rules', () => {
  it('flags a missing title as an error', () => {
    const r = rule('title.missing');
    expect(r.severity).toBe('error');
    expect(r.violated(product({ title: '' }))).toBe(true);
    expect(r.violated(product({ title: 'Rocket Kit' }))).toBe(false);
  });

  it('flags a missing brand as an ACP error (ACP requires brand)', () => {
    const r = rule('brand.missing');
    expect(r.protocol).toBe('acp');
    expect(r.severity).toBe('error');
    expect(r.violated(product({}))).toBe(true);
    expect(r.violated(product({ brand: 'Acme' }))).toBe(false);
  });

  it('flags a missing image as an error', () => {
    expect(rule('image.missing').violated(product({}))).toBe(true);
    expect(
      rule('image.missing').violated(product({ imageUrl: 'https://x/i.jpg' })),
    ).toBe(false);
  });
});

describe('description quality rules (from the Rails logic)', () => {
  it('flags a thin description (< 20 chars) as a warning, not an error', () => {
    const r = rule('description.thin');
    expect(r.severity).toBe('warn');
    expect(r.violated(product({ description: 'A rocket.' }))).toBe(true);
    expect(
      r.violated(product({ description: 'A detailed beginner rocket kit.' })),
    ).toBe(false);
    // Absent description is the concern of description.missing, not thin.
    expect(r.violated(product({}))).toBe(false);
  });

  it('flags a description with raw HTML as misformatted (warn)', () => {
    const r = rule('description.html');
    expect(r.violated(product({ description: '<p>Buy now</p>' }))).toBe(true);
    expect(r.violated(product({ description: 'Plain text is fine.' }))).toBe(
      false,
    );
  });
});

describe('identifier rules (per PROTOCOL-NOTES section 7 reconciliation)', () => {
  it('treats a missing GTIN as advisory (info), NOT an error', () => {
    const r = rule('gtin.missing');
    expect(r.severity).toBe('info');
    expect(r.violated(product({}))).toBe(true);
    expect(r.violated(product({ gtin: '00012345678905' }))).toBe(false);
  });

  it('flags a malformed GTIN (not 8-14 digits) when one is present', () => {
    const r = rule('gtin.format');
    expect(r.violated(product({ gtin: '12-34' }))).toBe(true);
    expect(r.violated(product({ gtin: '00012345678905' }))).toBe(false);
    // No GTIN at all is gtin.missing's job, not a format violation.
    expect(r.violated(product({}))).toBe(false);
  });
});

describe('format rules', () => {
  it('flags a price with no currency', () => {
    const r = rule('price.currency');
    expect(r.violated(product({ price: '29.99' }))).toBe(true);
    expect(r.violated(product({ price: '29.99', currency: 'USD' }))).toBe(
      false,
    );
  });

  it('flags an unrecognized availability value', () => {
    const r = rule('availability.enum');
    expect(r.violated(product({ availability: 'maybe' }))).toBe(true);
    expect(r.violated(product({ availability: 'in stock' }))).toBe(false);
    expect(r.violated(product({ availability: 'in_stock' }))).toBe(false);
  });

  it('flags a non-HTTPS image URL', () => {
    const r = rule('image.https');
    expect(r.violated(product({ imageUrl: 'http://x/i.jpg' }))).toBe(true);
    expect(r.violated(product({ imageUrl: 'https://x/i.jpg' }))).toBe(false);
  });
});
