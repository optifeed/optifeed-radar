/**
 * Pure {@link BrandProfile} assembly and merge rules (M4).
 *
 * `buildProfile` folds extracted signals + discovered competitors into the
 * persisted shape; `buildProfileFromFlags` is the no-fetch degraded fallback;
 * `mergeProfile` implements the "user edits always win" rule for `--refresh`.
 */
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type BusinessType,
  type ProfileField,
} from '../types.js';
import { brandFromDomain, type ExtractedSignals } from './extract.js';

/** All source-carrying fields, in a stable order for deterministic merges. */
const PROFILE_FIELDS: ProfileField[] = [
  'brand',
  'aliases',
  'category',
  'offerings',
  'locale',
  'competitors',
  'businessType',
];

export interface BuildProfileInput {
  domain: string;
  signals: ExtractedSignals;
  competitors: string[];
  /** How the discovery call classified the business (M5a), when it did. */
  businessType?: BusinessType;
  generatedAt: string;
}

/** Assemble a profile from extracted signals and the (llm) competitor list. */
export function buildProfile(input: BuildProfileInput): BrandProfile {
  const { domain, signals, competitors, generatedAt } = input;
  const sources = { ...signals.sources };
  if (competitors.length > 0) sources.competitors = 'llm';
  if (input.businessType) sources.businessType = 'llm';

  return {
    schema_version: SCHEMA_VERSION,
    domain,
    brand: signals.brand,
    aliases: signals.aliases,
    ...(signals.category ? { category: signals.category } : {}),
    ...(signals.offerings ? { offerings: signals.offerings } : {}),
    ...(signals.locale ? { locale: signals.locale } : {}),
    competitors,
    ...(input.businessType ? { businessType: input.businessType } : {}),
    generatedAt,
    sources,
  };
}

export interface FlagInput {
  brand?: string;
  category?: string;
  generatedAt: string;
}

/**
 * Apply `--brand`/`--category` flags over an existing profile, overriding ONLY
 * the flagged fields (marked `user`) and preserving every other curated field.
 * This is the flags path when a profile already exists - it must never wipe
 * fields the flags do not mention.
 */
export function applyFlags(
  existing: BrandProfile,
  flags: FlagInput,
): BrandProfile {
  const merged: BrandProfile = {
    ...existing,
    generatedAt: flags.generatedAt,
    sources: { ...existing.sources },
  };
  if (flags.brand !== undefined) {
    merged.brand = flags.brand;
    merged.sources = { ...merged.sources, brand: 'user' };
  }
  if (flags.category !== undefined) {
    merged.category = flags.category;
    merged.sources = { ...merged.sources, category: 'user' };
  }
  return merged;
}

export interface FlagProfileInput {
  domain: string;
  brand?: string;
  category?: string;
  generatedAt: string;
}

/**
 * Build a profile from `--brand`/`--category` flags with no fetch. Flagged
 * fields are `user`-sourced and the profile is `degraded` (fetch-derived
 * features flag themselves off downstream).
 */
export function buildProfileFromFlags(input: FlagProfileInput): BrandProfile {
  const { domain, brand, category, generatedAt } = input;
  const sources: BrandProfile['sources'] = { brand: 'user' };
  if (category) sources.category = 'user';

  return {
    schema_version: SCHEMA_VERSION,
    domain,
    brand: brand ?? brandFromDomain(domain),
    aliases: [],
    ...(category ? { category } : {}),
    competitors: [],
    degraded: true,
    generatedAt,
    sources,
  };
}

/**
 * Merge a freshly discovered profile over an existing one. A field whose
 * existing source is `user` is never overwritten; every other field takes the
 * fresh value/source. The refresh stamps the fresh `generatedAt`.
 */
export function mergeProfile(
  existing: BrandProfile,
  fresh: BrandProfile,
): BrandProfile {
  const merged: BrandProfile = {
    ...fresh,
    sources: { ...fresh.sources },
  };

  for (const field of PROFILE_FIELDS) {
    if (existing.sources?.[field] === 'user') {
      // Preserve the user's value and its source verbatim.
      (merged[field] as unknown) = existing[field];
      merged.sources = { ...merged.sources, [field]: 'user' };
    }
  }

  // `geo` is only ever set by a manual edit (discovery never extracts it) and
  // is not a source-tracked field, so always carry an existing geo forward.
  if (existing.geo !== undefined && merged.geo === undefined) {
    merged.geo = existing.geo;
  }

  // A user-degraded profile that later gets a real fetch is no longer degraded;
  // fresh already reflects that, so nothing to carry from existing here.
  return merged;
}
