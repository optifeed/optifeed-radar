/**
 * Fetch a feed by URL (M2) and lint it (M14). The fetcher is injected, so this
 * unit-tests with a fake and no network (hard rule #3). A fetch failure is
 * surfaced as a `parseError` in the report, never thrown - the same
 * graceful-failure contract the parser follows.
 */
import type { Fetcher } from '../fetcher/index.js';
import type { FeedLintReport } from '../types.js';
import { buildFeedLintReport, lintFeedContent } from './lint.js';

/** The slice of the M2 {@link Fetcher} this module needs. */
export type FeedFetcher = Pick<Fetcher, 'fetchUrl'>;

/** Fetch the feed at `url` and lint its body. */
export async function lintFeedUrl(
  url: string,
  fetcher: FeedFetcher,
): Promise<FeedLintReport> {
  const result = await fetcher.fetchUrl(url);
  if (!result.ok) {
    return buildFeedLintReport(url, {
      products: [],
      format: 'unknown',
      parseErrors: [
        `Could not fetch feed at ${url}: ${result.error} (${result.kind}).`,
      ],
    });
  }

  const report = lintFeedContent(result.body, { source: url });
  // A truncated body (hit the fetcher size cap) means the tail item is cut off
  // and later products are missing - findings/score are partial. Surface it so
  // a truncated feed is never read as a complete one (rule #6).
  if (result.truncated) {
    report.parseErrors = [
      `Feed was truncated at the fetch size cap; results are partial (some products and the final item may be missing).`,
      ...report.parseErrors,
    ];
  }
  return report;
}
