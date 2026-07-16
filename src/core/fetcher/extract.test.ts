import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPage } from './extract.js';

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/fetcher/${name}`, import.meta.url),
    'utf8',
  );

describe('extractPage', () => {
  it('pulls title, meta description, lang, h1, og, json-ld and links from rich HTML', () => {
    const page = extractPage(fixture('rich.html'));

    expect(page.title).toBe('Acme Espresso - Home Espresso Machines');
    expect(page.metaDescription).toBe(
      'Premium home espresso machines and grinders.',
    );
    expect(page.lang).toBe('en-US');
    expect(page.h1).toBe('Espresso machines for your kitchen');
    expect(page.canonical).toBe('https://acme.example/');
    expect(page.og.site_name).toBe('Acme Espresso');
    expect(page.og.type).toBe('website');

    // Both JSON-LD blocks parsed into objects.
    expect(page.jsonLd).toHaveLength(2);
    expect(page.jsonLd[0]).toMatchObject({ '@type': 'Organization' });

    // Links captured (relative kept as-authored here; resolution is the caller's job).
    expect(page.links).toContain('/products');
    expect(page.links).toContain('https://acme.example/about');
  });

  it('degrades gracefully on malformed HTML (no throw, partial fields)', () => {
    let page!: ReturnType<typeof extractPage>;
    expect(() => {
      page = extractPage(fixture('malformed.html'));
    }).not.toThrow();

    expect(page.lang).toBe('de');
    expect(page.title).toContain('Kaputt');
    expect(page.h1).toContain('Willkommen');
    // Invalid/absent JSON-LD yields an empty array, never a crash.
    expect(page.jsonLd).toEqual([]);
  });

  it('matches meta/rel attribute values case-insensitively (real sites vary casing)', () => {
    // apple.com serves <meta name="Description"> with a capital D; HTML attribute
    // values like name/rel are effectively case-insensitive, so we must not miss
    // them (a case-sensitive selector reported "no meta description" on apple.com).
    const page = extractPage(
      '<html><head>' +
        '<meta name="Description" content="Capital-D description.">' +
        '<link rel="Canonical" href="https://acme.example/">' +
        '</head><body></body></html>',
    );
    expect(page.metaDescription).toBe('Capital-D description.');
    expect(page.canonical).toBe('https://acme.example/');
  });

  it('normalizes case-varying og keys to lowercase (consumers read og.site_name)', () => {
    // The case-insensitive selector matches og:Site_Name, but the key must be
    // stored lowercase or discovery (which reads p.og.site_name) never sees it.
    const page = extractPage(
      '<html><head>' +
        '<meta property="og:Site_Name" content="Acme Corp">' +
        '<meta property="OG:Locale" content="en_GB">' +
        '</head><body></body></html>',
    );
    expect(page.og.site_name).toBe('Acme Corp');
    expect(page.og.locale).toBe('en_GB');
  });

  it('skips invalid JSON-LD blocks without failing', () => {
    const page = extractPage(
      '<html><head><script type="application/ld+json">{ not json }</script></head><body></body></html>',
    );
    expect(page.jsonLd).toEqual([]);
  });
});
