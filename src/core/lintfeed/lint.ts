/**
 * Run the lint rules over a parsed feed and build the {@link FeedLintReport}
 * (M14): per-product findings, a per-field graded feed score (the Rails model),
 * and a per-protocol readiness verdict. Pure and deterministic - no network, no
 * clock. `lintFeedContent` is the entry point over raw feed text.
 */
import {
  SCHEMA_VERSION,
  type FeedLintReport,
  type FeedProduct,
  type LintFinding,
  type LintRule,
  type ProductLintResult,
  type ProtocolReadiness,
} from '../types.js';
import { parseFeed, type FeedFormat, type ParseResult } from './parse.js';
import { LINT_RULES } from './rules.js';

/** Run every rule over one product; `sku` falls back to the positional index. */
export function lintProduct(
  product: FeedProduct,
  index: number,
  rules: LintRule[] = LINT_RULES,
): ProductLintResult {
  const sku = product.id?.trim() ? product.id.trim() : `#${index}`;
  const findings: LintFinding[] = rules
    .filter((rule) => rule.violated(product))
    .map((rule) => ({
      ruleId: rule.id,
      protocol: rule.protocol,
      severity: rule.severity,
      field: rule.field,
      message: rule.message,
      docsUrl: rule.docsUrl,
      sku,
    }));
  return { sku, findings };
}

/** Fields that count toward the graded score (error/warn rules; info excluded). */
function scoredFields(rules: LintRule[]): string[] {
  const fields = new Set<string>();
  for (const rule of rules) {
    if (rule.severity !== 'info') fields.add(rule.field);
  }
  return [...fields];
}

/**
 * Feed score 0-100: the share of gap-free `product x scored-field` cells. A
 * field is "gapped" for a product when it has any error/warn finding on that
 * field, so a single bad field costs one cell, not the whole product (the Rails
 * per-field graded model). Info-severity findings (advisory) never lower it.
 */
function computeFeedScore(
  results: ProductLintResult[],
  rules: LintRule[],
): number {
  const fields = scoredFields(rules);
  const total = results.length * fields.length;
  if (total === 0) return 0;

  let gapped = 0;
  for (const result of results) {
    const gappedFields = new Set(
      result.findings.filter((f) => f.severity !== 'info').map((f) => f.field),
    );
    // Only count fields that are actually scored (guards against a stray field).
    gapped += fields.filter((f) => gappedFields.has(f)).length;
  }
  return Math.round(100 * (1 - gapped / total));
}

function verdictFor(score: number): string {
  if (score >= 100) return 'ready';
  if (score >= 80) return 'nearly ready';
  return 'not ready';
}

/**
 * Readiness for one protocol: the share of products with NO error-severity
 * finding tagged that protocol (or `both`). Errors block readiness; warn/info
 * do not.
 */
function computeReadiness(
  results: ProductLintResult[],
  protocol: 'acp' | 'ucp',
  productCount: number,
): ProtocolReadiness {
  if (productCount === 0) return { protocol, score: 0, verdict: 'not ready' };

  const ready = results.filter(
    (result) =>
      !result.findings.some(
        (f) =>
          f.severity === 'error' &&
          (f.protocol === protocol || f.protocol === 'both'),
      ),
  ).length;
  const score = Math.round((100 * ready) / productCount);
  return { protocol, score, verdict: verdictFor(score) };
}

/** Build the full report from a parse result. */
export function buildFeedLintReport(
  source: string,
  parsed: ParseResult,
  rules: LintRule[] = LINT_RULES,
): FeedLintReport {
  const results = parsed.products.map((product, i) =>
    lintProduct(product, i, rules),
  );
  const productCount = parsed.products.length;

  const summary = { error: 0, warn: 0, info: 0 };
  for (const result of results) {
    for (const f of result.findings) summary[f.severity] += 1;
  }

  return {
    schema_version: SCHEMA_VERSION,
    source,
    format: parsed.format,
    productCount,
    products: results.filter((r) => r.findings.length > 0),
    summary,
    feedScore: computeFeedScore(results, rules),
    readiness: [
      computeReadiness(results, 'acp', productCount),
      computeReadiness(results, 'ucp', productCount),
    ],
    parseErrors: parsed.parseErrors,
  };
}

export interface LintFeedOptions {
  /** Where the feed came from (a URL, or `inline`). */
  source?: string;
  /** Force a format instead of auto-detecting. */
  format?: FeedFormat;
  /** Override the rule table (tests / future config). */
  rules?: LintRule[];
}

/** Parse and lint raw feed content. Pure - failures are surfaced, never thrown. */
export function lintFeedContent(
  content: string,
  opts: LintFeedOptions = {},
): FeedLintReport {
  const parsed = parseFeed(content, opts.format);
  return buildFeedLintReport(opts.source ?? 'inline', parsed, opts.rules);
}
