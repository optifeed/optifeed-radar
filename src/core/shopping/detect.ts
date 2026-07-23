/**
 * Deterministic pass-1 product detection (M12a).
 *
 * The brand check matches against a KNOWN competitor list (M4 discovered it).
 * One level down there is no such list: the rival products an engine names are
 * whatever it happened to recommend. So pass 1 extracts the answer's own
 * recommendation list - "the shelf" - and reads the product's rank off it. That
 * shelf is also what makes an absent product interesting rather than a zero
 * (design requirement 3): it is the competitive intel the merchant came for.
 *
 * Pure: no network, no judge. Genuinely unclear cases are FLAGGED here and
 * resolved by the guarded judge pass (`judge.ts`), never guessed at.
 */
import { analyzeAnswer } from '../scoring/index.js';
import { fold, indexOfTerm } from '../text.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type MentionResult,
  type ProductEntity,
} from '../types.js';

/** Most recommendations we keep from one answer (a shelf, not a catalog). */
const MAX_SHELF = 10;

/** Longest string we will accept as a product name (past this it is prose). */
const MAX_NAME_LENGTH = 60;

/**
 * How long an answer must be before "no list and no mention" is treated as
 * unclear rather than simply negative. A one-line "it depends" answer really
 * does recommend nothing; a 200+ character answer that our parser found no
 * structure in may well be recommending products in prose.
 */
const PROSE_AMBIGUITY_LENGTH = 200;

/** Editorial slot labels engines put in front of the actual product name. */
const LABEL_WORDS = new Set([
  'best',
  'budget',
  'runner',
  'runner-up',
  'top',
  'editor',
  'editors',
  'our',
  'premium',
  'value',
  'overall',
  'winner',
  'honorable',
  'splurge',
  'upgrade',
  'cheapest',
  'luxury',
  'alternative',
  'also',
]);

/** Headings and list items that structure an answer but name no product. */
const SECTION_PHRASES = [
  'conclusion',
  'summary',
  'in summary',
  'overview',
  'introduction',
  'recommendation',
  'recommendations',
  'things to consider',
  'what to look for',
  'key takeaway',
  'key takeaways',
  'final thought',
  'final thoughts',
  'bottom line',
  'how to choose',
  'faq',
  'frequently asked',
  'tips',
  'note',
  'notes',
  'comparison',
  'comparison table',
  'other options',
  'quick picks',
];

/** Delimiters that end a product name and begin its blurb. */
const DELIMITERS = [': ', ':', ' - ', ' -- ', ' | ', ' (', ', ', '; ', '. '];

function stripMarkdown(text: string): string {
  return text
    .split('**')
    .join('')
    .split('`')
    .join('')
    .split('__')
    .join('')
    .trim();
}

/** Strip a leading list marker or heading; returns null for an unstructured line. */
function stripMarker(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    return trimmed.replace(/^#{1,6}\s*/, '').trim() || null;
  }
  // "1. ", "12) " - walked by hand rather than matched, so no regex state or
  // exec-style extraction is involved.
  let digits = 0;
  while (digits < 2 && /\d/.test(trimmed[digits] ?? '')) digits += 1;
  if (digits > 0) {
    const punct = trimmed[digits];
    const space = trimmed[digits + 1];
    if ((punct === '.' || punct === ')') && space === ' ') {
      const rest = trimmed.slice(digits + 2).trim();
      return rest === '' ? null : rest;
    }
  }
  for (const bullet of ['- ', '* ', '• ', '+ ']) {
    if (trimmed.startsWith(bullet)) return trimmed.slice(bullet.length).trim();
  }
  // A bold lead-in with no marker at all ("**Aria 2** is the one to beat").
  if (trimmed.startsWith('**')) return trimmed;
  return null;
}

/** Whether `text` is an editorial slot label ("Best overall", "Budget pick"). */
function isLabel(text: string): boolean {
  const words = fold(text).trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first || words.length > 4) return false;
  return LABEL_WORDS.has(first.replace(/[^\p{L}\p{N}-]/gu, ''));
}

/** Whether `text` names a section of the answer rather than a product. */
function isSection(text: string): boolean {
  const folded = fold(text)
    .trim()
    .replace(/[:.?!]+$/, '');
  return SECTION_PHRASES.some(
    (phrase) => folded === phrase || folded.startsWith(`${phrase} `),
  );
}

/** Cut a candidate at its first delimiter, stepping past an editorial label. */
function nameFromCandidate(candidate: string, depth = 0): string {
  const text = candidate.trim();
  if (!text) return '';

  // A bold run wins outright: engines bold the product name and nothing else.
  if (text.startsWith('**')) {
    const end = text.indexOf('**', 2);
    if (end > 2) return stripMarkdown(text.slice(2, end));
  }

  let cut = -1;
  let delimiter = '';
  for (const d of DELIMITERS) {
    const idx = text.indexOf(d);
    if (idx > 0 && (cut === -1 || idx < cut)) {
      cut = idx;
      delimiter = d;
    }
  }
  if (cut === -1) return stripMarkdown(text);

  const left = text.slice(0, cut);
  const right = text.slice(cut + delimiter.length);
  // "Best overall: Breville Bambino Plus" - the name is on the RIGHT of the
  // label. Bounded recursion so a chain of labels cannot loop.
  if (depth < 2 && right.trim() && isLabel(left)) {
    return nameFromCandidate(right, depth + 1);
  }
  return stripMarkdown(left);
}

function isPlausibleName(name: string): boolean {
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) return false;
  if (!/\p{L}/u.test(name)) return false;
  return !isSection(name);
}

/**
 * The ordered list of products an answer recommends, first-mentioned first.
 *
 * Engines format recommendations in several ways and all of them are real
 * (lesson #4): numbered lists, bullets, markdown headings, and bold lead-in
 * paragraphs. Anything with no such structure yields an empty shelf, which is a
 * signal in itself - `analyzeProductAnswer` sends those to the judge rather
 * than reading them as "recommends nothing".
 */
export function extractRecommendations(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const candidate = stripMarker(line);
    if (candidate === null || isSection(candidate)) continue;
    const name = nameFromCandidate(candidate);
    if (!isPlausibleName(name)) continue;
    const key = fold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_SHELF) break;
  }
  return names;
}

/**
 * One product's analysis of one engine answer.
 *
 * Structurally a {@link MentionResult}, so M7's scoring aggregation
 * (`scoreEngine`, `compositeScore`) applies unchanged - one formula, one
 * `SCORING_VERSION`, no forked maths (rule #6).
 */
export interface ProductMention extends MentionResult {
  /** The MERCHANT's name for this product, never an engine-echoed variant. */
  product: string;
  /** The answer's recommendation list, in the order it presented them. */
  shelf: string[];
}

/** Every name this product answers to. */
export function productTerms(product: ProductEntity): string[] {
  return [product.name, ...(product.aliases ?? [])]
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Whether a shelf entry refers to this product (boundary-aware, folded). */
export function shelfEntryIsProduct(entry: string, terms: string[]): boolean {
  const folded = fold(entry);
  return terms.some((term) => indexOfTerm(folded, term) !== -1);
}

/**
 * A name with one token is easy to match by accident ("Bambino" inside a
 * sentence about the Breville Bambino Plus, "Classic" anywhere at all). Product
 * names are messier than brand names, which is exactly why this module gets a
 * 50% judge budget rather than the brand check's 30%.
 */
function isRiskyName(name: string): boolean {
  return fold(name).trim().split(/\s+/).filter(Boolean).length < 2;
}

/** Analyze one engine answer for one product (deterministic pass 1). */
export function analyzeProductAnswer(
  answer: EngineAnswer,
  product: ProductEntity,
): ProductMention {
  const terms = productTerms(product);
  const shelf = extractRecommendations(answer.text);
  const others = shelf.filter((entry) => !shelfEntryIsProduct(entry, terms));

  // Delegate the shared reading of an answer - term matching, the sentiment
  // lexicon with its negation handling, citation domains, entity ordering - to
  // M7 rather than copying it here, with the product standing in for the brand
  // and the shelf standing in for the known competitor list.
  const asProfile: BrandProfile = {
    schema_version: SCHEMA_VERSION,
    // Deliberately blank: a product is not a domain, and passing the store's
    // domain would count "acme.com" in an answer as a mention of this product.
    domain: '',
    brand: product.name,
    aliases: product.aliases ?? [],
    competitors: others,
  };
  const base = analyzeAnswer(answer, asProfile);

  // Rank is read off the SHELF (the order the answer presented), not off first
  // appearance in the text: "your #1 is AI's #4" is a claim about the list the
  // shopper sees. A mention with no shelf entry is unranked, not rank 1 - M7
  // credits unranked mentions at a mid-list default rather than as the top pick.
  const shelfIndex = shelf.findIndex((entry) =>
    shelfEntryIsProduct(entry, terms),
  );
  const position = base.mentioned && shelfIndex >= 0 ? shelfIndex + 1 : null;

  const ambiguous = base.mentioned
    ? position === null || isRiskyName(product.name)
    : // No mention AND no structure we could parse, on an answer long enough to
      // be recommending something: pass 1 cannot tell "recommends nothing" from
      // "recommends in prose we did not parse". Ask the judge.
      shelf.length === 0 && answer.text.trim().length > PROSE_AMBIGUITY_LENGTH;

  return {
    ...base,
    position,
    ambiguous,
    product: product.name,
    shelf,
  };
}
