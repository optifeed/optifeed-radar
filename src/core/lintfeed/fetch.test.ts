import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FetchResult } from '../fetcher/index.js';
import { lintFeedUrl, type FeedFetcher } from './fetch.js';

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/lintfeed/${name}`, import.meta.url),
    'utf8',
  );

const okFetcher = (body: string): FeedFetcher => ({
  fetchUrl: async (url: string): Promise<FetchResult> => ({
    ok: true,
    url,
    finalUrl: url,
    status: 200,
    body,
    contentType: 'application/xml',
    truncated: false,
  }),
});

const errFetcher = (): FeedFetcher => ({
  fetchUrl: async (url: string): Promise<FetchResult> => ({
    ok: false,
    url,
    error: 'connection refused',
    kind: 'network',
  }),
});

describe('lintFeedUrl', () => {
  it('fetches then lints the feed (source is the URL)', async () => {
    const report = await lintFeedUrl(
      'https://acme.example/feed.xml',
      okFetcher(fixture('clean.xml')),
    );
    expect(report.source).toBe('https://acme.example/feed.xml');
    expect(report.productCount).toBe(2);
    expect(report.parseErrors).toEqual([]);
  });

  it('surfaces a fetch failure as a parseError, never throwing', async () => {
    const report = await lintFeedUrl(
      'https://down.example/feed.xml',
      errFetcher(),
    );
    expect(report.productCount).toBe(0);
    expect(report.parseErrors.join(' ')).toMatch(/could not fetch/i);
    for (const r of report.readiness) expect(r.verdict).toBe('not assessed');
  });

  it('flags a truncated feed so partial results are not read as complete (rule #6)', async () => {
    const truncatedFetcher: FeedFetcher = {
      fetchUrl: async (url: string): Promise<FetchResult> => ({
        ok: true,
        url,
        finalUrl: url,
        status: 200,
        body: fixture('clean.xml'),
        contentType: 'application/xml',
        truncated: true,
      }),
    };
    const report = await lintFeedUrl(
      'https://big.example/feed.xml',
      truncatedFetcher,
    );
    expect(report.parseErrors.join(' ')).toMatch(/truncat/i);
  });
});
