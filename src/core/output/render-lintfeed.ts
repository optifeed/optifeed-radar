/**
 * Render a {@link FeedLintReport} (M14's data, M9's renderer): what a product
 * feed gets wrong for the ACP/UCP shopping protocols. Consumes the report only
 * - never re-lints. An unassessable feed reports "not assessed" rather than a
 * fabricated 0 (rule #6), and parse errors always surface. Ends with the single
 * footer CTA; no em-dash.
 */
import pc from 'picocolors';
import type { FeedLintReport, Severity } from '../types.js';
import { FOOTER_CTA } from './footer.js';
import { plural, renderNoteBlock, type TextRenderOptions } from './terminal.js';

const SEVERITY_TAG: Record<Severity, string> = {
  error: '[fail]',
  warn: '[warn]',
  info: '[info]',
};

/** Stable pretty JSON of the lint report (carries `schema_version`). */
export function renderFeedLintJson(report: FeedLintReport): string {
  return JSON.stringify(report, null, 2);
}

/** "78/100", or an honest "not assessed" when the feed could not be scored. */
function scoreText(score: number | null): string {
  return score === null ? 'not assessed' : `${score}/100`;
}

/** "1 error, 1 warning, 2 advisories" - only the severities actually present. */
function summaryText(summary: FeedLintReport['summary']): string {
  const parts: string[] = [];
  if (summary.error > 0) parts.push(plural(summary.error, 'error'));
  if (summary.warn > 0) parts.push(plural(summary.warn, 'warning'));
  // `plural` appends a bare "s", which "advisory" does not take.
  if (summary.info > 0) {
    parts.push(`${summary.info} advis${summary.info === 1 ? 'ory' : 'ories'}`);
  }
  return parts.join(', ');
}

/** Plain-text lint report for `lint-feed <url>`. */
export function renderFeedLintText(
  report: FeedLintReport,
  opts: TextRenderOptions = {},
): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const lines: string[] = [];

  lines.push(c.bold(`Feed lint: ${report.source}`));
  lines.push(
    `Format: ${report.format} (${plural(report.productCount, 'product')})`,
  );
  lines.push(c.bold(`Feed quality score: ${scoreText(report.feedScore)}`));
  lines.push('');

  if (report.readiness.length > 0) {
    lines.push('Protocol readiness:');
    for (const r of report.readiness) {
      // An unassessed protocol has no score to report, and its verdict already
      // says so - "not assessed (not assessed)" would just repeat itself.
      const score = r.score === null ? '' : ` (${r.score}/100)`;
      lines.push(`  ${r.protocol.padEnd(6)}${r.verdict}${score}`);
    }
    lines.push('');
  }

  if (report.products.length === 0) {
    // Distinguish a genuinely clean feed from one that was never assessed -
    // "no findings" over an unparsed feed would read as a pass (rule #6).
    lines.push(
      report.feedScore === null
        ? 'The feed could not be assessed, so no rules were checked against it.'
        : 'No findings: every product passed the rules checked.',
    );
    lines.push('');
  } else {
    lines.push(`Findings: ${summaryText(report.summary)}`);
    for (const product of report.products) {
      lines.push(`  ${c.bold(product.sku)}`);
      for (const f of product.findings) {
        lines.push(`    ${SEVERITY_TAG[f.severity]} ${f.message}`);
      }
    }
    lines.push('');
  }

  lines.push(...renderNoteBlock('Notes', report.parseErrors, c));
  lines.push(FOOTER_CTA);
  return lines.join('\n');
}
