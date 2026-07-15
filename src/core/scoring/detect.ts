/**
 * Deterministic pass-1 mention detection (M7).
 *
 * Pure: no network, no judge. Case/accent-folded, word-boundary matching of the
 * brand (name + aliases + domain) and known competitors. Ambiguous cases
 * (generic-word brand) are flagged for the judge pass, not resolved here.
 */
import { fold, indexOfTerm } from '../text.js';
import type {
  BrandProfile,
  EngineAnswer,
  MentionResult,
  Sentiment,
} from '../types.js';

export { fold };

/** Common single-word brands that collide with everyday words (judge disambiguates). */
const GENERIC_WORDS = new Set([
  'apple',
  'orange',
  'amazon',
  'shell',
  'gap',
  'next',
  'square',
  'dove',
  'monster',
  'ace',
]);

const POSITIVE_WORDS = [
  'best',
  'great',
  'excellent',
  'recommend',
  'recommended',
  'top',
  'love',
  'reliable',
  'favorite',
  'trusted',
  'quality',
];
const NEGATIVE_WORDS = [
  'avoid',
  'poor',
  'bad',
  'worst',
  'scam',
  'unreliable',
  'terrible',
  'disappointing',
  'overpriced',
  'complaints',
];

/** Earliest index at which any of `terms` appears, or -1. Boundary-aware. */
function earliestIndex(foldedText: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const idx = indexOfTerm(foldedText, term);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

const POSITIVE = new Set(POSITIVE_WORDS);
const NEGATIVE = new Set(NEGATIVE_WORDS);
const NEGATORS = new Set([
  'not',
  'no',
  'never',
  'without',
  'hardly',
  'cannot',
  'cant',
  'dont',
  'doesnt',
  'didnt',
  'isnt',
  'arent',
  'wasnt',
  'werent',
  'wont',
  'wouldnt',
  'couldnt',
  'shouldnt',
]);
const NEGATION_WINDOW = 3;

/**
 * Lexicon sentiment with negation handling: a positive word negated within the
 * preceding few tokens ("not reliable", "would not recommend") counts negative,
 * and a negated negative is discounted to neutral rather than flipped positive.
 */
function detectSentiment(foldedText: string): Sentiment {
  const tokens = foldedText
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  let pos = 0;
  let neg = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isPos = POSITIVE.has(token);
    const isNeg = NEGATIVE.has(token);
    if (!isPos && !isNeg) continue;
    const negated = tokens
      .slice(Math.max(0, i - NEGATION_WINDOW), i)
      .some((w) => NEGATORS.has(w));
    if (isPos) {
      if (negated) neg++;
      else pos++;
    } else if (!negated) {
      neg++; // a negated negative is discounted to neutral (skipped)
    }
  }

  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function domainsFromCitations(citations: string[] | undefined): string[] {
  if (!citations) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of citations) {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/** Analyze one engine answer against the brand profile (deterministic pass 1). */
export function analyzeAnswer(
  answer: EngineAnswer,
  profile: BrandProfile,
): MentionResult {
  const folded = fold(answer.text);
  const brandTerms = [profile.brand, ...profile.aliases, profile.domain];

  // Brand mention + its first-appearance index.
  const brandIdx = earliestIndex(folded, brandTerms);
  const mentioned = brandIdx !== -1;

  // Entities = brand (if present) + competitors present, by first appearance.
  const found: { name: string; idx: number }[] = [];
  if (mentioned) found.push({ name: profile.brand, idx: brandIdx });
  for (const competitor of profile.competitors) {
    if (fold(competitor).trim() === fold(profile.brand).trim()) continue;
    const idx = indexOfTerm(folded, competitor);
    if (idx !== -1) found.push({ name: competitor, idx });
  }
  found.sort((a, b) => a.idx - b.idx);
  const entities = found.map((f) => f.name);

  const position = mentioned ? entities.indexOf(profile.brand) + 1 : null;

  // Ambiguous when a generic single-word brand matched (needs the judge).
  const brandFolded = fold(profile.brand).trim();
  const ambiguous = mentioned && GENERIC_WORDS.has(brandFolded);

  return {
    engine: answer.engine,
    prompt: answer.prompt,
    mentioned,
    position,
    sentiment: mentioned ? detectSentiment(folded) : 'neutral',
    entities,
    citedDomains: domainsFromCitations(answer.citations),
    ambiguous,
  };
}
