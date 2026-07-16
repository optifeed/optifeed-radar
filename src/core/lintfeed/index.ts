/**
 * Public API of the lint-feed module (M14). Import from `core/lintfeed`.
 *
 * Validates a product feed (Google Shopping XML or ACP-style JSON) against the
 * ACP + UCP requirements pinned in `PROTOCOL-NOTES.md` plus the Rails
 * agent-readiness quality checks. Pure lint core (`lintFeedContent`) + an
 * injected-fetch wrapper (`lintFeedUrl`); the rule table (`LINT_RULES`) is the
 * reviewable spec. Findings, a per-field graded feed score, and a per-protocol
 * readiness verdict out. Never throws - parse/fetch failures are surfaced.
 */
export { LINT_RULES } from './rules.js';
export { parseFeed, detectFormat } from './parse.js';
export type { FeedFormat, ParseResult } from './parse.js';
export {
  lintFeedContent,
  lintProduct,
  buildFeedLintReport,
  type LintFeedOptions,
} from './lint.js';
export { lintFeedUrl, type FeedFetcher } from './fetch.js';
