import { describe, expect, it } from 'vitest';
import type { ExtractedPage } from '../fetcher/index.js';
import { extractSignals } from './extract.js';

/** Minimal ExtractedPage with sensible empty defaults for the fields under test. */
function page(overrides: Partial<ExtractedPage>): ExtractedPage {
  return { og: {}, jsonLd: [], links: [], ...overrides };
}

describe('extractSignals', () => {
  it('prefers og:site_name for the brand and collects aliases from JSON-LD + domain', () => {
    const home = page({
      lang: 'en-US',
      og: { site_name: 'Acme Rockets' },
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'Acme Rockets Inc',
          alternateName: 'Acme',
          description: 'Hobby model rocket kits and engines',
          url: 'https://acme.example',
        },
      ],
    });

    const signals = extractSignals('acme.example', [home]);

    expect(signals.brand).toBe('Acme Rockets');
    // Aliases: the other names, deduped case-insensitively, brand removed.
    // Domain stem "Acme" collapses into the alternateName "Acme".
    expect(signals.aliases).toEqual(['Acme Rockets Inc', 'Acme']);
    expect(signals.category).toBe('Hobby model rocket kits and engines');
    expect(signals.locale).toBe('en-US');
    expect(signals.sources.brand).toBe('extracted');
    expect(signals.sources.locale).toBe('extracted');
  });

  it('falls back to the domain stem and meta description when no structured data', () => {
    const home = page({
      title: 'Welcome',
      metaDescription: 'Handmade leather bags and wallets.',
    });

    const signals = extractSignals('shop.dukane.co.uk', [home]);

    expect(signals.brand).toBe('Dukane'); // domain stem, not the "co" label
    expect(signals.aliases).toEqual([]); // stem == brand, nothing else
    expect(signals.category).toBe('Handmade leather bags and wallets.');
    expect(signals.offerings).toBeUndefined();
    expect(signals.locale).toBeUndefined();
    expect(signals.sources.category).toBe('extracted');
    expect(signals.sources.offerings).toBeUndefined();
  });

  it('degrades to a bare domain-stem brand for a JS-shell page (no signals)', () => {
    const shell = page({ title: 'Loading...' });

    const signals = extractSignals('velo.io', [shell]);

    expect(signals.brand).toBe('Velo');
    expect(signals.aliases).toEqual([]);
    expect(signals.category).toBeUndefined();
    expect(signals.offerings).toBeUndefined();
    expect(signals.locale).toBeUndefined();
  });

  it('collects offerings from JSON-LD Product names across pages', () => {
    const p1 = page({
      jsonLd: [{ '@type': 'Product', name: 'Orbit Kit' }],
    });
    const p2 = page({
      jsonLd: [
        { '@type': 'Product', name: 'Comet Kit' },
        { '@type': 'Product', name: 'Orbit Kit' }, // dup across pages
      ],
    });

    const signals = extractSignals('acme.example', [p1, p2]);

    expect(signals.offerings).toEqual(['Orbit Kit', 'Comet Kit']);
    expect(signals.sources.offerings).toBe('extracted');
  });
});
