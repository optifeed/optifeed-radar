/**
 * Deterministic pass-1 mention detection (M7).
 *
 * Pure: no network, no judge. Case/accent-folded, word-boundary matching of the
 * brand (name + aliases + domain) and known competitors. Ambiguous cases
 * (generic-word brand) are flagged for the judge pass, not resolved here.
 */
import type {
  BrandProfile,
  EngineAnswer,
  MentionResult,
  Sentiment,
} from '../types.js';

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

/** Lowercase and strip diacritics so "Café" matches "cafe". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First match index of `term` in already-folded `text`, or -1. Word-boundary. */
function firstIndexOf(foldedText: string, term: string): number {
  const folded = fold(term).trim();
  if (!folded) return -1;
  // A domain (contains a dot) is matched literally; names use word boundaries.
  const pattern = folded.includes('.')
    ? escapeRegExp(folded)
    : `\\b${escapeRegExp(folded)}\\b`;
  return foldedText.search(new RegExp(pattern));
}

/** Earliest index at which any of `terms` appears, or -1. */
function earliestIndex(foldedText: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const idx = firstIndexOf(foldedText, term);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function detectSentiment(foldedText: string): Sentiment {
  const count = (words: string[]) =>
    words.reduce(
      (n, w) => n + (new RegExp(`\\b${w}\\b`).test(foldedText) ? 1 : 0),
      0,
    );
  const pos = count(POSITIVE_WORDS);
  const neg = count(NEGATIVE_WORDS);
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
    const idx = firstIndexOf(folded, competitor);
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
