import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { FetchResult, Fetcher, SitemapResult } from '../fetcher/index.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
} from '../types.js';
import { discover } from './discover.js';
import { profilePath, type ProfileFs } from './persist.js';

const AT = '2026-07-15T12:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../test/fixtures/discovery/${name}`, import.meta.url),
    'utf8',
  );
}

function ok(url: string, body: string): FetchResult {
  return {
    ok: true,
    url,
    finalUrl: url,
    status: 200,
    body,
    contentType: 'text/html',
    truncated: false,
  };
}

/** A fake Fetcher serving fixtures by URL, recording every fetched URL. */
function fakeFetcher(
  pages: Record<string, string>,
  sitemapUrls: string[] = [],
) {
  const calls: string[] = [];
  const fetcher: Fetcher = {
    async fetchUrl(url) {
      calls.push(url);
      const body = pages[url];
      if (body === undefined) {
        return { ok: false, url, error: '404', kind: 'http', status: 404 };
      }
      return ok(url, body);
    },
    async fetchRobots(url): Promise<FetchResult> {
      return { ok: false, url, error: 'n/a', kind: 'http' };
    },
    async fetchLlmsTxt(url): Promise<FetchResult> {
      return { ok: false, url, error: 'n/a', kind: 'http' };
    },
    async fetchSitemap(): Promise<SitemapResult> {
      return { urls: sitemapUrls, truncated: false, errors: [] };
    },
  };
  return { fetcher, calls };
}

function judge(text: string): JudgeClient & {
  calls: number;
  prompts: string[];
} {
  return {
    calls: 0,
    prompts: [],
    model: 'gpt-4o-mini',
    async complete(prompt) {
      this.calls += 1;
      this.prompts.push(prompt);
      return { text, costUsd: 0.001, model: 'gpt-4o-mini' };
    },
  };
}

/** In-memory ProfileFs seeded with optional files. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: ProfileFs = {
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async mkdir() {},
  };
  return { fs, files };
}

describe('discover', () => {
  it('discovers a full profile from a schema-rich site and persists it', async () => {
    const { fetcher, calls } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes", "Quest Aerospace"]');
    const { fs, files } = memFs();

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    const p = result.profile;
    expect(p.schema_version).toBe(SCHEMA_VERSION);
    expect(p.brand).toBe('Acme Rockets');
    expect(p.aliases).toContain('Acme');
    expect(p.category).toBe('Hobby model rocket kits and engines since 1974');
    expect(p.locale).toBe('en-US');
    expect(p.offerings).toEqual(['Orbit Starter Kit']);
    expect(p.competitors).toEqual(['Estes', 'Quest Aerospace']);
    // The extracted locale must REACH the competitor call, not just the profile
    // (live 2026-07-17: a `tr` brand got 8 US chains, 0 of which ever appeared).
    expect(j.prompts[0]).toContain('en-US');
    expect(p.sources?.competitors).toBe('llm');
    expect(p.degraded).toBeUndefined();

    // Persisted to profile.json.
    expect(result.path).toBe(profilePath('/state'));
    expect(files.has(profilePath('/state'))).toBe(true);
    expect(calls).toContain('https://acme.example/');
  });

  it('reuses an existing profile without fetching or judging (no --refresh)', async () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme Rockets',
      aliases: ['Acme'],
      competitors: ['Estes'],
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: { brand: 'extracted' },
    };
    const { fetcher, calls } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes"]');
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify(existing),
    });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.fromCache).toBe(true);
    expect(result.profile).toEqual(existing);
    expect(calls).toEqual([]); // no network
    expect(j.calls).toBe(0); // no judge spend
  });

  it('never serves a cached profile for a different domain (shared state dir)', async () => {
    // A flat, writable-project state dir holds one brand's profile; a run for a
    // DIFFERENT domain must re-discover, not analyze the wrong brand.
    const otherBrand: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'figma.com',
      brand: 'Figma',
      aliases: ['Figma'],
      competitors: ['Adobe XD'],
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: { brand: 'extracted' },
    };
    const { fetcher, calls } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes"]');
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify(otherBrand),
    });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.fromCache).toBeUndefined(); // did NOT reuse figma's cache
    expect(result.profile.domain).toBe('acme.example');
    expect(result.profile.brand).toBe('Acme Rockets'); // discovered fresh
    expect(result.profile.competitors).not.toContain('Adobe XD'); // no bleed
    expect(calls).toContain('https://acme.example/'); // actually fetched
  });

  it('re-discovers (does not abort) when the cached profile has an incompatible schema_version', async () => {
    // After a future schema bump, a returning user's stale profile.json must
    // not abort the run with a stack trace - it transparently re-discovers.
    const stale = {
      schema_version: '0.2', // from a prior, incompatible version
      domain: 'acme.example',
      brand: 'Old Cached Name',
      aliases: [],
      competitors: [],
    };
    const { fetcher } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes"]');
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify(stale),
    });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.fromCache).toBeUndefined(); // did NOT reuse the stale cache
    expect(result.profile.brand).toBe('Acme Rockets'); // discovered fresh
  });

  it('--refresh re-discovers but preserves user-edited fields', async () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'ACME Rocketry', // hand-edited
      aliases: ['Acme'],
      category: 'Old category',
      competitors: ['Estes'],
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: { brand: 'user', category: 'extracted' },
    };
    const { fetcher } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes", "Quest"]');
    const { fs } = memFs({
      [profilePath('/state')]: JSON.stringify(existing),
    });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', refresh: true },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.profile.brand).toBe('ACME Rocketry'); // user field kept
    expect(result.profile.sources?.brand).toBe('user');
    expect(result.profile.category).toBe(
      'Hobby model rocket kits and engines since 1974',
    ); // non-user field refreshed
    expect(result.profile.generatedAt).toBe(AT);
  });

  it('flag override preserves an existing curated profile (no data loss)', async () => {
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
    const { fetcher, calls } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes"]');
    const { fs } = memFs({ [profilePath('/state')]: JSON.stringify(existing) });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', brand: 'Acme Rockets' },
    );

    expect(result.profile.brand).toBe('Acme Rockets'); // flag applied
    expect(result.profile.sources?.brand).toBe('user');
    // Curated fields survive.
    expect(result.profile.competitors).toEqual(['Estes', 'Quest']);
    expect(result.profile.offerings).toEqual(['Orbit Kit']);
    expect(result.profile.geo).toBe('Berlin');
    expect(calls).toEqual([]); // still no fetch on the flags path
    expect(j.calls).toBe(0);
  });

  it('does not clobber a good cached profile when a refresh fetch fails', async () => {
    const existing: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme Rockets',
      aliases: ['Acme'],
      category: 'model rockets',
      competitors: ['Estes'],
      sources: { brand: 'extracted' },
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    // Empty page map: homepage fetch fails, sitemap empty -> zero pages.
    const { fetcher } = fakeFetcher({});
    const j = judge('["Estes"]');
    const { fs } = memFs({ [profilePath('/state')]: JSON.stringify(existing) });

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', refresh: true },
    );

    expect(result.profile).toEqual(existing); // kept intact
    expect(result.competitorNote).toMatch(/fetch/i);
  });

  it('returns a degraded stem profile when the fetch fails and no profile exists', async () => {
    const { fetcher } = fakeFetcher({});
    const j = judge('[]');
    const { fs } = memFs();

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.profile.brand).toBe('Acme'); // domain stem
    expect(result.profile.degraded).toBe(true);
  });

  it('builds a degraded profile from flags with no fetch', async () => {
    const { fetcher, calls } = fakeFetcher({
      'https://acme.example/': fixture('schema-rich.html'),
    });
    const j = judge('["Estes"]');
    const { fs } = memFs();

    const result = await discover(
      'acme.example',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', brand: 'Custom Co', category: 'Widgets' },
    );

    expect(result.profile.brand).toBe('Custom Co');
    expect(result.profile.category).toBe('Widgets');
    expect(result.profile.degraded).toBe(true);
    expect(calls).toEqual([]); // no fetch on the flags path
    expect(j.calls).toBe(0);
  });

  it('degrades gracefully on a JS-shell site with no flags', async () => {
    const { fetcher } = fakeFetcher({
      'https://velo.io/': fixture('js-shell.html'),
    });
    const j = judge('[]');
    const { fs } = memFs();

    const result = await discover(
      'velo.io',
      { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state' },
    );

    expect(result.profile.brand).toBe('Velo'); // domain stem fallback
    expect(result.profile.degraded).toBeUndefined(); // a fetch did happen
    expect(result.profile.competitors).toEqual([]);
  });
});
