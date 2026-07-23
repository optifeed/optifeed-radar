/**
 * Competitor discovery: the ONE judge-model call M4 makes (M4).
 *
 * Billed to the cost guard's setup budget (hard rule #5). It never throws - a
 * cap hit or a judge error degrades to an empty competitor list with a reason,
 * so discovery always returns a usable profile.
 */
import { CostGuard, approxTokens, estimateCallUsd } from '../costs.js';
import { extractBalanced, fold, mentionsTerm } from '../text.js';
import type { JudgeClient } from '../types.js';

/** Upper bound on competitors we keep from one call. */
const MAX_COMPETITORS = 8;

export interface CompetitorInput {
  brand: string;
  /**
   * Other names the brand goes by (the profile's extracted `aliases`). Named in
   * the prompt AND used to filter the answer: a judge asked to exclude only
   * `doremusic` still returns "Do Re Müzik Market", which is the brand itself.
   */
  aliases?: string[];
  category?: string;
  offerings?: string[];
  /**
   * The brand's primary market, from the profile's extracted `locale` (e.g.
   * `tr`, `en-US`). Without it the judge defaults to US/global brands, which
   * for a local retailer yields rivals that never appear in that market's
   * answers - a share-of-voice table of all zeroes.
   */
  locale?: string;
}

export interface CompetitorDeps {
  judge: JudgeClient;
  guard: CostGuard;
  /** Projected setup cost for authorization; defaults to a per-model estimate. */
  projectedCostUsd?: number;
}

export interface CompetitorResult {
  competitors: string[];
  /** Set when the call was skipped or failed (cap hit or judge error). */
  skipped?: string;
}

/** Build the judge prompt. Asks for a plain list of rival brand names. */
function buildPrompt(input: CompetitorInput): string {
  const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const parts = [`Brand: ${input.brand}`];
  if (aliases.length) parts.push(`Also known as: ${aliases.join(', ')}`);
  if (input.category) parts.push(`Category: ${input.category}`);
  if (input.offerings?.length) {
    parts.push(`Offerings: ${input.offerings.join(', ')}`);
  }
  if (input.locale) parts.push(`Primary market (locale): ${input.locale}`);
  return [
    'You are helping map a market. Given the brand below, list its main direct',
    'competitors (rival brands a shopper would compare it against).',
    '',
    parts.join('\n'),
    '',
    ...(input.locale
      ? [
          'Rank rivals that actually compete in that primary market first,',
          'including local and regional ones. Do NOT default to US or global',
          'brands unless they genuinely compete there.',
          '',
        ]
      : []),
    'Return ONLY a JSON array of competitor brand names, e.g. ["Foo", "Bar"].',
    'No commentary. Do not include the brand itself, any of the names above,',
    'or a variant spelling or translation of them.',
  ].join('\n');
}

/** Fold and strip everything but letters/numbers: "Do Re Music" -> "doremusic". */
function squeeze(name: string): string {
  return fold(name).replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Drop names that are the brand under another spelling.
 *
 * Live 2026-07-20, every judge returned the brand as its own rival ("Do Re
 * Müzik Market" for doremusic), which put the brand in its own share-of-voice
 * table. Matching is the shared Unicode-aware one (so case, accents and
 * boundaries behave like scoring's detector), applied BOTH ways - the returned
 * name may wrap a brand term ("Do Re Müzik Market") or be wrapped by one ("Do
 * Re" for "Do Re Müzik") - plus a squeezed comparison that catches respacing
 * ("Do Re Music" -> "doremusic"). Whole terms only: "Ace Rental" survives a
 * brand called "Ace Hardware". A brand whose alias is one generic word will
 * over-match, which is the same ambiguity M7 flags rather than a new risk.
 */
export function dropSelfReferences(names: string[], terms: string[]): string[] {
  const live = terms.map((t) => t.trim()).filter(Boolean);
  const squeezed = new Set(live.map(squeeze).filter(Boolean));
  return names.filter((name) => {
    const folded = fold(name);
    if (squeezed.has(squeeze(name))) return false;
    return !live.some(
      (term) => mentionsTerm(folded, term) || mentionsTerm(fold(term), name),
    );
  });
}

/**
 * Parse a competitor list from model output. Handles a JSON array or a
 * newline/comma list with bullets or numbering (lesson #4: parse real shapes).
 *
 * `selfTerms` (the brand and its aliases) are removed BEFORE the cap is
 * applied, so a judge that opens with three spellings of the brand still yields
 * a full list of rivals rather than spending slots on itself.
 */
export function parseCompetitors(
  text: string,
  selfTerms: string[] = [],
): string[] {
  const clean = (items: string[]): string[] =>
    capped(dropSelfReferences(dedupe(items), selfTerms));
  const trimmed = text.trim();

  // Prefer a JSON array if the model returned one (possibly fenced or followed
  // by prose - extractBalanced ignores later brackets that would break a slice).
  const candidate = extractBalanced(trimmed, '[', ']');
  if (candidate !== null) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return clean(parsed.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // Fall through to line parsing.
    }
  }

  // Otherwise split on newlines/commas and strip list markers.
  const items = trimmed
    .split(/[\n,]/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .map((line) => line.replace(/^["']|["']$/g, '').trim());
  return clean(items);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function capped(items: string[]): string[] {
  return items.slice(0, MAX_COMPETITORS);
}

/** Discover competitor brand names via one guarded judge call. */
export async function discoverCompetitors(
  input: CompetitorInput,
  deps: CompetitorDeps,
): Promise<CompetitorResult> {
  const { judge, guard } = deps;
  const prompt = buildPrompt(input);
  const maxTokens = 300;
  const projected =
    deps.projectedCostUsd ??
    estimateCallUsd(judge.model, approxTokens(prompt), maxTokens);

  if (!guard.authorize(projected, 'setup')) {
    return { competitors: [], skipped: 'setup cost cap reached' };
  }

  try {
    const res = await judge.complete(prompt, { maxTokens });
    // settle, not record: `authorize` reserved `projected`, and only settling
    // releases that hold (a leaked reservation shrinks the remaining budget).
    guard.settle(projected, res.costUsd, 'setup');
    const selfTerms = [input.brand, ...(input.aliases ?? [])];
    return { competitors: parseCompetitors(res.text, selfTerms) };
  } catch (err) {
    guard.settle(projected, 0, 'setup'); // failed call cost nothing; free the hold
    const reason = err instanceof Error ? err.message : String(err);
    return { competitors: [], skipped: `judge error: ${reason}` };
  }
}
