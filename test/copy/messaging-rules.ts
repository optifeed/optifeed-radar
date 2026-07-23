import { FOOTER_CTA } from '../../src/core/output/index.js';

export interface MessagingRuleOptions {
  /** Enforce that roadmap (Shopping) copy stays future-tense + waitlist-gated. */
  enforceRoadmapGate?: boolean;
  /** Require the single footer CTA to be present. */
  requireFooter?: boolean;
}

/** Substrings that must never appear in customer-facing copy. */
const BANNED: { needle: string; label: string; caseInsensitive?: boolean }[] = [
  { needle: '—', label: 'em-dash (use "-" instead)' },
  { needle: '–', label: 'en-dash (use "-" instead)' },
  { needle: 'OptiFeed', label: 'OptiFeed mis-casing (brand is "Optifeed")' },
  // Renamed at M16: the product is "Optifeed Radar" and the package is
  // "optifeed-radar". The old names outlived the rename in published copy.
  {
    needle: 'optifeed visibility',
    label: 'renamed: the product is "Optifeed Radar"',
    caseInsensitive: true,
  },
  {
    needle: 'optifeed-visibility',
    label: 'renamed: the package is "optifeed-radar"',
    caseInsensitive: true,
  },
  {
    needle: 'paid tools for free',
    label: 'free-vs-paid equivalence framing',
    caseInsensitive: true,
  },
  {
    needle: 'free alternative to paid',
    label: 'free-vs-paid equivalence framing',
    caseInsensitive: true,
  },
  // A `check` queries several engines across a whole prompt pack: measured at
  // 47-51s parametric and about 97s grounded, and the wait is provider latency
  // we do not control. Only `audit` is a seconds-scale command, and it is
  // described with its measured number rather than an adjective.
  {
    needle: 'results in seconds',
    label:
      'speed over-claim (a check takes about a minute; cite the measured time)',
    caseInsensitive: true,
  },
  {
    needle: 'instant results',
    label:
      'speed over-claim (a check takes about a minute; cite the measured time)',
    caseInsensitive: true,
  },
];

/**
 * What is still roadmap after scope revision 2 (2026-07-18).
 *
 * Shopping-lite SHIPPED, so present tense about the products a user NAMES is
 * now correct and must not be flagged. What has NOT shipped is everything that
 * would find those products for them (catalog/feed discovery) and feed linting
 * against the agentic-commerce protocols. Those two are what the gate now
 * guards, in both directions: no present-tense claim, and a waitlist link
 * whenever they are mentioned.
 */
const ROADMAP_TERMS = [
  'catalog discovery',
  'product discovery',
  'feed linting',
  'lint-feed',
  'lint your feed',
  'lints your feed',
  'shopify import',
];

/** Present-tense claims about work that has not shipped. */
const ROADMAP_PRESENT_TENSE = [
  'lints your feed',
  'lint your feed today',
  'checks your feed',
  'now supports feeds',
];

/**
 * Claims that the tool finds products by itself. It does not: the merchant
 * names them. This is the single most tempting overstatement in shopping copy,
 * and it is the one a merchant would discover is false within one run.
 */
const FALSE_DISCOVERY = [
  'scans your catalog',
  'scan your catalog',
  'reads your product feed',
  'read your product feed',
  'imports your shopify',
  'import your shopify',
  'finds your products',
  'discovers your products',
  'crawls your products',
];

export function findMessagingViolations(
  text: string,
  opts: MessagingRuleOptions,
): string[] {
  const violations: string[] = [];
  const lower = text.toLowerCase();

  for (const rule of BANNED) {
    const hay = rule.caseInsensitive ? lower : text;
    const needle = rule.caseInsensitive
      ? rule.needle.toLowerCase()
      : rule.needle;
    if (hay.includes(needle)) violations.push(`banned: ${rule.label}`);
  }

  if (opts.enforceRoadmapGate) {
    // Never claim the tool finds the products - the merchant names them.
    for (const phrase of FALSE_DISCOVERY) {
      if (lower.includes(phrase)) {
        violations.push(`discovery: claims product discovery ("${phrase}")`);
      }
    }
    for (const phrase of ROADMAP_PRESENT_TENSE) {
      if (lower.includes(phrase)) {
        violations.push(`roadmap: present-tense claim ("${phrase}")`);
      }
    }
    // Naming unshipped work is fine, but only alongside the waitlist link that
    // makes it a roadmap statement rather than a promise.
    const namesRoadmap = ROADMAP_TERMS.some((term) => lower.includes(term));
    if (namesRoadmap && !lower.includes('waitlist')) {
      violations.push(
        'waitlist: roadmap work mentioned without a waitlist gate',
      );
    }
  }

  if (opts.requireFooter && !text.includes(FOOTER_CTA)) {
    violations.push(`footer: missing CTA "${FOOTER_CTA}"`);
  }

  return violations;
}

/** Extract the contents of every ```json fenced block. No regex (hook-safe). */
export function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const parts = markdown.split('```json');
  for (const part of parts.slice(1)) {
    const end = part.indexOf('```');
    if (end !== -1) blocks.push(part.slice(0, end));
  }
  return blocks;
}
