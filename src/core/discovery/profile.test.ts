import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import type { ExtractedSignals } from './extract.js';
import {
  applyFlags,
  buildProfile,
  buildProfileFromFlags,
  mergeProfile,
} from './profile.js';

const AT = '2026-07-15T00:00:00.000Z';

describe('buildProfile', () => {
  it('assembles a profile from extracted signals + llm competitors', () => {
    const signals: ExtractedSignals = {
      brand: 'Acme Rockets',
      aliases: ['Acme'],
      category: 'Model rockets',
      offerings: ['Orbit Kit'],
      locale: 'en-US',
      sources: {
        brand: 'extracted',
        aliases: 'extracted',
        category: 'extracted',
        offerings: 'extracted',
        locale: 'extracted',
      },
    };

    const profile = buildProfile({
      domain: 'acme.example',
      signals,
      competitors: ['Estes', 'Quest'],
      generatedAt: AT,
    });

    expect(profile.schema_version).toBe(SCHEMA_VERSION);
    expect(profile.domain).toBe('acme.example');
    expect(profile.brand).toBe('Acme Rockets');
    expect(profile.competitors).toEqual(['Estes', 'Quest']);
    expect(profile.sources?.competitors).toBe('llm');
    expect(profile.sources?.brand).toBe('extracted');
    expect(profile.generatedAt).toBe(AT);
    expect(profile.degraded).toBeUndefined();
  });
});

describe('buildProfileFromFlags', () => {
  it('builds a degraded, user-sourced profile with no fetch', () => {
    const profile = buildProfileFromFlags({
      domain: 'acme.example',
      brand: 'Acme',
      category: 'Model rockets',
      generatedAt: AT,
    });

    expect(profile.brand).toBe('Acme');
    expect(profile.category).toBe('Model rockets');
    expect(profile.degraded).toBe(true);
    expect(profile.competitors).toEqual([]);
    expect(profile.sources?.brand).toBe('user');
    expect(profile.sources?.category).toBe('user');
  });

  it('derives a brand from the domain stem when --brand is omitted', () => {
    const profile = buildProfileFromFlags({
      domain: 'velo.io',
      generatedAt: AT,
    });
    expect(profile.brand).toBe('Velo');
    expect(profile.degraded).toBe(true);
  });
});

describe('applyFlags', () => {
  it('overrides only the flagged fields, preserving the rest as user-set', () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme',
      aliases: ['ACME'],
      category: 'rockets',
      offerings: ['Orbit Kit'],
      locale: 'en-US',
      geo: 'Berlin',
      competitors: ['Estes', 'Quest'],
      sources: { brand: 'extracted', competitors: 'llm' },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    const merged = applyFlags(existing, {
      brand: 'Acme Rockets',
      generatedAt: AT,
    });

    expect(merged.brand).toBe('Acme Rockets'); // flag wins
    expect(merged.sources?.brand).toBe('user');
    // Everything else survives untouched.
    expect(merged.competitors).toEqual(['Estes', 'Quest']);
    expect(merged.offerings).toEqual(['Orbit Kit']);
    expect(merged.geo).toBe('Berlin');
    expect(merged.generatedAt).toBe(AT);
  });
});

describe('mergeProfile', () => {
  it('preserves a user-edited geo when the fresh profile lacks it', () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme',
      aliases: [],
      geo: 'Berlin, Germany',
      competitors: [],
      sources: {},
    };
    const fresh: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme',
      aliases: [],
      competitors: [],
      sources: {},
      generatedAt: AT,
    };
    expect(mergeProfile(existing, fresh).geo).toBe('Berlin, Germany');
  });

  it('keeps user-sourced fields and takes fresh values for the rest', () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'ACME Rocketry', // hand-edited
      aliases: ['Acme'],
      category: 'Old category',
      competitors: ['Estes'],
      sources: { brand: 'user', aliases: 'extracted', category: 'extracted' },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fresh: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme Rockets', // re-extracted, should NOT win
      aliases: ['Acme', 'Acme Rockets Inc'],
      category: 'Model rockets', // re-extracted, should win
      competitors: ['Estes', 'Quest'],
      sources: {
        brand: 'extracted',
        aliases: 'extracted',
        category: 'extracted',
        competitors: 'llm',
      },
      generatedAt: AT,
    };

    const merged = mergeProfile(existing, fresh);

    expect(merged.brand).toBe('ACME Rocketry'); // user field preserved
    expect(merged.sources?.brand).toBe('user');
    expect(merged.category).toBe('Model rockets'); // non-user field refreshed
    expect(merged.aliases).toEqual(['Acme', 'Acme Rockets Inc']);
    expect(merged.competitors).toEqual(['Estes', 'Quest']);
    expect(merged.generatedAt).toBe(AT); // refresh stamps the new time
  });
});

describe('businessType (M5a)', () => {
  it('carries the discovered businessType and marks it llm-sourced', () => {
    const signals: ExtractedSignals = {
      brand: 'Shop',
      aliases: [],
      sources: { brand: 'extracted', aliases: 'extracted' },
    };

    const profile = buildProfile({
      domain: 'shop.example',
      signals,
      competitors: ['Rival Shop'],
      businessType: 'retailer',
      generatedAt: AT,
    });

    expect(profile.businessType).toBe('retailer');
    expect(profile.sources?.businessType).toBe('llm');
  });

  // A merchant who corrects a wrong classification must not lose it on the
  // next --refresh, the same rule every other profile field already follows.
  it('preserves a user-edited businessType across --refresh', () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'shop.example',
      brand: 'Shop',
      aliases: [],
      competitors: [],
      businessType: 'retailer',
      sources: { businessType: 'user' },
    };
    const fresh: BrandProfile = {
      ...existing,
      businessType: 'maker',
      sources: { businessType: 'llm' },
    };

    const merged = mergeProfile(existing, fresh);

    expect(merged.businessType).toBe('retailer');
    expect(merged.sources?.businessType).toBe('user');
  });
});
