/**
 * The lint-feed rule table (M14). THIS TABLE IS THE SPEC - a non-engineer can
 * read `LINT_RULES` and see exactly what is checked, per which protocol, at
 * what severity. It merges two inputs (see PROTOCOL-NOTES.md sections 6-7):
 *
 * - Rails `agent_readiness` quality checks (missing/thin/misformatted
 *   description, missing title/brand/image/gtin/q_and_a).
 * - ACP/UCP protocol conformance + format rules (identifier format, price
 *   currency, availability enum, HTTPS URLs).
 *
 * Two severity conflicts were resolved at reconciliation: `brand` is an ERROR
 * (ACP requires it, though Rails treats it as auto-fixable), and a missing
 * `gtin` is INFO/advisory (ACP makes it optional, though Rails flags a gap).
 */
import type { FeedProduct, LintRule } from '../types.js';

/** The canonical spec a merchant fixes against; shown as each finding's docs. */
const ACP_DOCS =
  'https://developers.openai.com/commerce/specs/file-upload/products';

const THIN_DESCRIPTION_CHARS = 20; // matches the Rails THIN_DESCRIPTION_CHARS.

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * True when `raw` has a non-blank value under any spelling variant of `name`
 * (separators normalized away). JSON keys are only lower-cased at parse time,
 * so `qAndA`/`q-and-a` land as `qanda`/`q-and-a` - a fixed-key lookup would miss
 * a field the merchant actually populated.
 */
function hasRawField(raw: Record<string, string>, name: string): boolean {
  const canonical = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return Object.entries(raw).some(
    ([key, value]) =>
      key.replace(/[^a-z0-9]/gi, '').toLowerCase() === canonical &&
      !isBlank(value),
  );
}

/** Availability values recognized across ACP + Google Shopping (normalized). */
const AVAILABILITY_VALUES = new Set([
  'in_stock',
  'out_of_stock',
  'pre_order',
  'preorder',
  'backorder',
  'unknown',
  'discontinued',
]);

function normalizeAvailability(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

const HAS_HTML = /<[a-z][\s\S]*?>/i;
const GTIN_FORMAT = /^\d{8,14}$/;

/**
 * The rule set. `violated(product)` returns true when the product breaks the
 * rule. Rules are pure and side-effect free.
 */
export const LINT_RULES: LintRule[] = [
  // --- Required fields (Rails quality + ACP conformance) ---
  {
    id: 'title.missing',
    protocol: 'both',
    severity: 'error',
    field: 'title',
    message: 'Missing title.',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.title),
  },
  {
    id: 'description.missing',
    protocol: 'both',
    severity: 'error',
    field: 'description',
    message: 'Missing description.',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.description),
  },
  {
    id: 'brand.missing',
    protocol: 'acp',
    severity: 'error',
    field: 'brand',
    message: 'Missing brand (required by ACP).',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.brand),
  },
  {
    id: 'image.missing',
    protocol: 'both',
    severity: 'error',
    field: 'image_url',
    message: 'Missing product image.',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.imageUrl),
  },
  {
    id: 'price.missing',
    protocol: 'both',
    severity: 'error',
    field: 'price',
    message: 'Missing price.',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.price),
  },

  // --- Description quality (Rails-only; not protocol-specified) ---
  {
    id: 'description.thin',
    protocol: 'both',
    severity: 'warn',
    field: 'description',
    message: `Description is under ${THIN_DESCRIPTION_CHARS} characters - too thin for AI agents to reason about.`,
    docsUrl: ACP_DOCS,
    violated: (p) =>
      !isBlank(p.description) &&
      p.description!.trim().length < THIN_DESCRIPTION_CHARS,
  },
  {
    id: 'description.html',
    protocol: 'both',
    severity: 'warn',
    field: 'description',
    message: 'Description contains raw HTML markup; use plain text.',
    docsUrl: ACP_DOCS,
    violated: (p) => !isBlank(p.description) && HAS_HTML.test(p.description!),
  },

  // --- Identifiers (reconciled severities, PROTOCOL-NOTES section 7) ---
  {
    id: 'gtin.missing',
    protocol: 'acp',
    severity: 'info',
    field: 'gtin',
    message:
      'No GTIN supplied (optional, but it improves matching by AI agents).',
    docsUrl: ACP_DOCS,
    violated: (p) => isBlank(p.gtin),
  },
  {
    id: 'gtin.format',
    protocol: 'both',
    severity: 'warn',
    field: 'gtin',
    message: 'GTIN must be 8-14 digits with no dashes or spaces.',
    docsUrl: ACP_DOCS,
    violated: (p) => !isBlank(p.gtin) && !GTIN_FORMAT.test(p.gtin!.trim()),
  },

  // --- Formats (protocol conformance) ---
  {
    id: 'price.currency',
    protocol: 'acp',
    severity: 'warn',
    field: 'price',
    message: 'Price has no ISO 4217 currency.',
    docsUrl: ACP_DOCS,
    violated: (p) => !isBlank(p.price) && isBlank(p.currency),
  },
  {
    id: 'availability.enum',
    protocol: 'acp',
    severity: 'warn',
    field: 'availability',
    message:
      'Availability is not a recognized value (in_stock, out_of_stock, pre_order, backorder, unknown).',
    docsUrl: ACP_DOCS,
    violated: (p) =>
      !isBlank(p.availability) &&
      !AVAILABILITY_VALUES.has(normalizeAvailability(p.availability!)),
  },
  {
    id: 'url.https',
    protocol: 'both',
    severity: 'warn',
    field: 'url',
    message: 'Product URL should be HTTPS.',
    docsUrl: ACP_DOCS,
    violated: (p) => !isBlank(p.url) && !/^https:\/\//i.test(p.url!.trim()),
  },
  {
    id: 'image.https',
    protocol: 'both',
    severity: 'warn',
    field: 'image_url',
    message: 'Image URL should be HTTPS.',
    docsUrl: ACP_DOCS,
    violated: (p) =>
      !isBlank(p.imageUrl) && !/^https:\/\//i.test(p.imageUrl!.trim()),
  },

  // --- Quality signal (Rails-only) ---
  {
    id: 'qanda.missing',
    protocol: 'both',
    severity: 'info',
    field: 'q_and_a',
    message: 'No Q&A content (helps AI agents answer buyer questions).',
    docsUrl: ACP_DOCS,
    violated: (p: FeedProduct) => !hasRawField(p.raw, 'q_and_a'),
  },
];
