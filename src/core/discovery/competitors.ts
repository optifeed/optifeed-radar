/**
 * Competitor discovery: the ONE judge-model call M4 makes (M4).
 *
 * Billed to the cost guard's setup budget (hard rule #5). It never throws - a
 * cap hit or a judge error degrades to an empty competitor list with a reason,
 * so discovery always returns a usable profile.
 */
import { CostGuard, approxTokens, estimateCallUsd } from '../costs.js';
import { extractBalanced, fold, mentionsTerm } from '../text.js';
import type { BusinessType, JudgeClient } from '../types.js';

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
  /** How the judge classified the business (M5a); absent when unknown. */
  businessType?: BusinessType;
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
    'Also classify the business itself, because it decides which rivals are the',
    'right ones: "retailer" sells products made by other companies (a shop or',
    'marketplace), "maker" sells products it makes itself, "service" sells',
    'services. For a retailer list rival shops a buyer would buy from instead,',
    'NEVER the manufacturers it stocks; for a maker list rival makers.',
    '',
    'Return ONLY a JSON object of the form',
    '{"businessType": "retailer", "competitors": ["Foo", "Bar"]}.',
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

/**
 * Parse the discovery call's response: `{"businessType", "competitors"}`.
 *
 * A model that ignores that shape and returns a bare array must still yield
 * competitors (lesson #4: parse every real shape, not just the canonical one) -
 * the rival list is the older and more important half of this call. An
 * unrecognized `businessType` is DROPPED rather than trusted, so an unexpected
 * value degrades to the maker axis that shipped before M5a instead of silently
 * rewriting someone's prompt pack.
 */
/** First value whose key matches any `names`, compared case-insensitively. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (names.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

export function parseDiscovery(
  text: string,
  selfTerms: string[] = [],
): { businessType?: BusinessType; competitors: string[] } {
  const object = extractBalanced(text.trim(), '{', '}');
  if (object !== null) {
    try {
      const parsed: unknown = JSON.parse(object);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const row = parsed as Record<string, unknown>;
        const raw = pick(row, 'businesstype', 'business_type');
        const businessType =
          raw === 'retailer' || raw === 'maker' || raw === 'service'
            ? raw
            : undefined;
        const named = pick(row, 'competitors', 'rivals');
        const list = Array.isArray(named)
          ? named.filter((x): x is string => typeof x === 'string')
          : [];
        const competitors = capped(dropSelfReferences(dedupe(list), selfTerms));
        // Only let the object branch win when it actually found something. A
        // model that wraps the list under a key we did not anticipate must not
        // come back EMPTY when the array parser below would have read it: this
        // exact class (a case-sensitive wrapper-key lookup returning zero rows)
        // already shipped once and was caught in the M14 review.
        if (businessType || competitors.length > 0) {
          return {
            ...(businessType ? { businessType } : {}),
            competitors,
          };
        }
      }
    } catch {
      // Fall through to the array/list parser.
    }
  }
  return { competitors: parseCompetitors(text, selfTerms) };
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
    return parseDiscovery(res.text, selfTerms);
  } catch (err) {
    guard.settle(projected, 0, 'setup'); // failed call cost nothing; free the hold
    const reason = err instanceof Error ? err.message : String(err);
    return { competitors: [], skipped: `judge error: ${reason}` };
  }
}
