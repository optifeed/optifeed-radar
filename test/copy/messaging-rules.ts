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
];

/**
 * Present-tense Shopping claims - Shopping is roadmap (future tense only). This
 * list is illustrative, not exhaustive; the real structural guard is the
 * `waitlist` requirement below (any surface that says "shopping" must gate on a
 * waitlist). Add phrases here as they come up, but do not rely on it alone.
 */
const ROADMAP_PRESENT_TENSE = [
  'shopping checks',
  'shopping supports',
  'shopping scores',
  'now supports sku',
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

  if (opts.enforceRoadmapGate && lower.includes('shopping')) {
    for (const phrase of ROADMAP_PRESENT_TENSE) {
      if (lower.includes(phrase)) {
        violations.push(`roadmap: present-tense Shopping claim ("${phrase}")`);
      }
    }
    if (!lower.includes('waitlist')) {
      violations.push('waitlist: Shopping mentioned without a waitlist gate');
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
