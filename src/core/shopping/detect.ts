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
 * Most words a product name has. Measured against real answers: the longest
 * genuine name seen was "Nespresso Lattissima or Creatista line" (5), while the
 * feature bullets that used to leak onto the shelf ("Automatic milk steaming
 * with adjustable temp and texture") run longer.
 */
const MAX_NAME_WORDS = 6;

/**
 * Share of a multi-word candidate's words that must be capitalized for it to
 * read as a NAME rather than a sentence fragment. "Breville Bambino Plus" is
 * 3 of 3; "Heats up in ~3 seconds" is 1 of 5.
 */
const MIN_CAPITALIZED_SHARE = 0.5;

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
  // Feature and verdict words that survive the delimiter cut of a spec bullet:
  // "Compact, reliable, and quiet" cuts to "Compact", "Downside: you still
  // grind" cuts to "Downside". All observed on real answers (2026-07-23).
  'compact',
  'downside',
  'downsides',
  'upside',
  'upsides',
  'drawback',
  'drawbacks',
  'touchscreen',
  'pros',
  'cons',
  'price',
  'pricing',
  'verdict',
  'features',
  'specs',
  'specifications',
  'warranty',
  'design',
  'performance',
  'value',
  'quality',
  'caveat',
  'tradeoff',
  'trade-off',
];

/** Words that open a price band rather than a product name. */
const PRICE_LEADS = new Set([
  'around',
  'about',
  'under',
  'over',
  'from',
  'up',
  'starting',
  'approximately',
  'roughly',
  'budget',
  'price',
  'cost',
]);

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

/**
 * How a candidate line was marked up. Bold is the strongest signal that a line
 * names a product; an UNMARKED line (a bare paragraph naming the product, with
 * its features bulleted underneath - a real and common shape) is the weakest,
 * so it has to clear a higher bar.
 */
type Marking = 'bold' | 'list' | 'unmarked';

interface Candidate {
  text: string;
  marking: Marking;
}

/** Strip a leading list marker or heading; returns null for a blank line. */
function stripMarker(line: string): Candidate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Bold anywhere inside a marker is still bold: "1. **Bambino** - the pick"
  // and "- **Bambino**" are the same signal as a bare "**Bambino**".
  const as = (text: string, marking: Marking): Candidate | null => {
    const inner = text.trim();
    if (!inner) return null;
    return { text: inner, marking: inner.startsWith('**') ? 'bold' : marking };
  };

  if (trimmed.startsWith('#')) {
    return as(trimmed.replace(/^#{1,6}\s*/, ''), 'list');
  }
  // "1. ", "12) " - walked by hand rather than matched, so no regex state or
  // exec-style extraction is involved.
  let digits = 0;
  while (digits < 2 && /\d/.test(trimmed[digits] ?? '')) digits += 1;
  if (digits > 0) {
    const punct = trimmed[digits];
    const space = trimmed[digits + 1];
    if ((punct === '.' || punct === ')') && space === ' ') {
      return as(trimmed.slice(digits + 2), 'list');
    }
  }
  for (const bullet of ['- ', '* ', '• ', '+ ']) {
    if (trimmed.startsWith(bullet))
      return as(trimmed.slice(bullet.length), 'list');
  }
  // A bare paragraph line. Real answers do name a product this way and bullet
  // its features underneath, so these are candidates - but weak ones, held to
  // the extra bar in `isPlausibleName`.
  return as(trimmed, 'unmarked');
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

/** Whether a string opens like a proper name: a capital letter or a digit. */
function startsLikeName(text: string): boolean {
  const first = [...text.trim()].find((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (first === undefined) return false;
  return /\p{N}/u.test(first) || first === first.toUpperCase();
}

/** Cut a candidate at its first delimiter, stepping past an editorial label. */
function nameFromCandidate(candidate: string, depth = 0): string {
  const text = candidate.trim();
  if (!text) return '';

  // A bold run wins outright: engines bold the product name and nothing else.
  // Its CONTENT still goes through the delimiter pass, because the bold often
  // wraps the editorial label too ("**Best overall for beginners: Breville
  // Barista Express Impress**" - live, 2026-07-23).
  if (text.startsWith('**') && depth === 0) {
    const end = text.indexOf('**', 2);
    if (end > 2) return nameFromCandidate(stripMarkdown(text.slice(2, end)), 1);
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
  //
  // What follows a label is only taken when it READS as a name: a slot label is
  // as often followed by its own justification as by a product ("Best overall
  // (reliable, great app, strong mapping)" put "reliable" on a live shelf,
  // 2026-07-23). A proper name starts with a capital or carries a model number.
  if (depth < 2 && right.trim() && isLabel(left)) {
    const behind = nameFromCandidate(right, depth + 1);
    return startsLikeName(behind) ? behind : '';
  }
  return stripMarkdown(left);
}

/**
 * Whether a candidate reads as a NAME rather than as a sentence about a
 * product. Real answers bullet a product's FEATURES under its name, and those
 * bullets survive every structural test - they are bulleted, short enough, and
 * start with a capital. What separates them is prose shape: they run long and
 * their words are mostly lowercase ("Heats up in ~3 seconds", "Built-in grinder
 * + auto milk steaming"), while a product name is title-cased or carries a
 * model code.
 *
 * Words without letters (model numbers like "3200/4300") are neutral: they are
 * neither evidence for nor against, so they leave the ratio alone.
 */
function readsAsName(name: string, marking: Marking): boolean {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > MAX_NAME_WORDS) return false;

  // A price band read as a name: "Around $700-$800", "Under $500".
  const lead = fold(words[0] ?? '').replace(/[^\p{L}]/gu, '');
  if (PRICE_LEADS.has(lead)) return false;

  if (words.length < 2) {
    // One-word candidates are only trusted when the answer BOLDED them. A
    // bulleted comparison writes its spec keys exactly like this - "Height:",
    // "Corners:", "Bonus:" - and those went onto a real shelf as rival
    // products (live, 2026-07-23). A genuinely one-word product name
    // ("Bambino") is almost always bolded or numbered as a pick.
    return marking === 'bold';
  }

  const alphabetic = words.filter((w) => /\p{L}/u.test(w));
  if (alphabetic.length === 0) return true;
  const capitalized = alphabetic.filter((w) => {
    const first = [...w].find((ch) => /\p{L}/u.test(ch));
    return first?.toUpperCase() === first;
  }).length;
  return capitalized / alphabetic.length > MIN_CAPITALIZED_SHARE;
}

function isPlausibleName(name: string, marking: Marking): boolean {
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) return false;
  if (!/\p{L}/u.test(name)) return false;
  if (isSection(name)) return false;
  return readsAsName(name, marking);
}

/**
 * The ordered list of products an answer recommends, first-mentioned first.
 *
 * Engines format recommendations in several ways and all of them are real
 * (lesson #4): numbered lists, bullets, markdown headings, and bold lead-in
 * paragraphs. Anything with no such structure yields an empty shelf, which is a
 * signal in itself - `analyzeProductAnswer` sends those to the judge rather
 * than reading them as "recommends nothing".
 *
 * What a candidate must survive to reach the shelf is `isPlausibleName`: real
 * answers bullet a product's FEATURES underneath its name, and those bullets
 * are structurally identical to a list of products. Live runs on 2026-07-23 put
 * "Automatic milk steaming with adjustable temp and texture", "Compact" and
 * "Height" on merchants' shelves as if they were rival products, which is what
 * those filters exist to stop.
 */
export function extractRecommendations(text: string): string[] {
  const all: { name: string; marking: Marking }[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const candidate = stripMarker(line);
    if (candidate === null || isSection(candidate.text)) continue;
    const name = nameFromCandidate(candidate.text);
    if (!isPlausibleName(name, candidate.marking)) continue;
    const key = fold(name);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ name, marking: candidate.marking });
  }

  return all.slice(0, MAX_SHELF).map((c) => c.name);
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
