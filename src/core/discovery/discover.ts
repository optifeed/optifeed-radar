/**
 * The discovery orchestrator: one domain in, an editable {@link BrandProfile}
 * out (M4).
 *
 * It is the only stateful piece of M4 - it fetches (M2), extracts (pure),
 * makes the one guarded competitor judge call, merges with any persisted
 * profile (user edits win), and writes `profile.json`. Everything I/O is
 * injected so the whole flow unit-tests with no network and no disk.
 */
import { CostGuard } from '../costs.js';
import { type Fetcher, extractPage } from '../fetcher/index.js';
import type { BrandProfile, JudgeClient } from '../types.js';
import { discoverCompetitors } from './competitors.js';
import { extractSignals } from './extract.js';
import {
  applyFlags,
  buildProfile,
  buildProfileFromFlags,
  mergeProfile,
} from './profile.js';
import {
  loadProfile,
  nodeProfileFs,
  saveProfile,
  type ProfileFs,
} from './persist.js';

/** Injected collaborators. Only `fetcher` is required. */
export interface DiscoverDeps {
  fetcher: Fetcher;
  /** Judge for the competitor call; omit to skip competitor discovery. */
  judge?: JudgeClient;
  /** Cost guard for the setup budget; defaults to an uncapped guard. */
  guard?: CostGuard;
  /** Profile persistence; defaults to the real node fs. */
  fs?: ProfileFs;
  /** Clock, injected for deterministic `generatedAt`. */
  now?: () => string;
}

export interface DiscoverOptions {
  /** Where `profile.json` lives (from `resolveStateDir`). */
  stateDir: string;
  /** Re-discover even if a profile exists; user fields still win. */
  refresh?: boolean;
  /** `--brand`: take the no-fetch degraded path. */
  brand?: string;
  /** `--category`: no-fetch degraded path (with or without `--brand`). */
  category?: string;
  /** Max sitemap pages to sample in addition to the homepage (default 5). */
  samplePages?: number;
  /** Persist the result to disk (default true). */
  persist?: boolean;
}

export interface DiscoverResult {
  profile: BrandProfile;
  /** Path the profile was written to, if persisted. */
  path?: string;
  /** True when an existing profile was returned without re-discovery. */
  fromCache?: boolean;
  /** Reason competitor discovery was skipped, if any. */
  competitorNote?: string;
}

function originOf(domain: string): string {
  const withProto = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return new URL(withProto).origin;
}

/** Homepage + up to `samplePages` sitemap pages, extracted. Failures drop out. */
async function gatherPages(
  domain: string,
  fetcher: Fetcher,
  samplePages: number,
) {
  const origin = originOf(domain);
  const [home, sitemap] = await Promise.all([
    fetcher.fetchUrl(`${origin}/`),
    fetcher.fetchSitemap(`${origin}/sitemap.xml`),
  ]);

  const pages = [];
  if (home.ok) pages.push(extractPage(home.body));

  const sampled = await Promise.all(
    sitemap.urls.slice(0, samplePages).map((url) => fetcher.fetchUrl(url)),
  );
  for (const res of sampled) {
    if (res.ok) pages.push(extractPage(res.body));
  }
  return pages;
}

/** Discover (or reuse) a brand profile for `domain`. */
export async function discover(
  domain: string,
  deps: DiscoverDeps,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const fs = deps.fs ?? nodeProfileFs();
  const now = deps.now ?? (() => new Date().toISOString());
  const guard = deps.guard ?? new CostGuard();
  const persist = opts.persist ?? true;
  const samplePages = opts.samplePages ?? 5;

  const write = async (profile: BrandProfile) =>
    persist ? await saveProfile(profile, opts.stateDir, fs) : undefined;

  // Never serve a cached profile for a different domain: the writable-project
  // state dir is a flat `<cwd>/.optifeed` shared across brands, so it can hold
  // another domain's profile. Treat a mismatch as no cache - discover fresh
  // rather than analyze the wrong brand. (Same invariant `diff` enforces before
  // comparing two snapshots.)
  const loaded = await loadProfile(opts.stateDir, fs);
  const existing = loaded?.domain === domain ? loaded : undefined;

  // Flags path: no fetch. Override ONLY the flagged fields over an existing
  // profile (preserving every curated field); build from scratch if none.
  if (opts.brand !== undefined || opts.category !== undefined) {
    const profile = existing
      ? applyFlags(existing, {
          brand: opts.brand,
          category: opts.category,
          generatedAt: now(),
        })
      : buildProfileFromFlags({
          domain,
          brand: opts.brand,
          category: opts.category,
          generatedAt: now(),
        });
    return { profile, path: await write(profile) };
  }

  // Reuse a persisted profile unless the caller asked to refresh.
  if (existing && !opts.refresh) {
    return { profile: existing, fromCache: true };
  }

  // Fresh discovery: fetch -> extract -> one guarded competitor call.
  const pages = await gatherPages(domain, deps.fetcher, samplePages);

  // Total fetch failure: never clobber a good cached profile with a stem-only
  // one. Keep the existing profile, or (if none) return a degraded stem profile.
  if (pages.length === 0) {
    if (existing) {
      return {
        profile: existing,
        fromCache: true,
        competitorNote: 'fetch failed; kept the existing profile',
      };
    }
    const degradedStem: BrandProfile = {
      ...buildProfile({
        domain,
        signals: extractSignals(domain, []),
        competitors: [],
        generatedAt: now(),
      }),
      degraded: true,
    };
    return {
      profile: degradedStem,
      path: await write(degradedStem),
      competitorNote: 'fetch failed; degraded to a domain-only profile',
    };
  }

  const signals = extractSignals(domain, pages);

  let competitors: string[] = [];
  let competitorNote: string | undefined;
  if (deps.judge) {
    const res = await discoverCompetitors(
      {
        brand: signals.brand,
        category: signals.category,
        offerings: signals.offerings,
      },
      { judge: deps.judge, guard },
    );
    competitors = res.competitors;
    competitorNote = res.skipped;
  } else {
    competitorNote = 'no judge configured';
  }

  const fresh = buildProfile({
    domain,
    signals,
    competitors,
    generatedAt: now(),
  });
  const profile = existing ? mergeProfile(existing, fresh) : fresh;

  return { profile, path: await write(profile), competitorNote };
}
