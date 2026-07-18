/**
 * Query generation (M5): profile -> buyer prompts, via ONE guarded judge call.
 *
 * Pure helpers (intent selection, parsing, competitor exclusion, pack assembly)
 * are separated from the single I/O function `generateQueries`, so the whole
 * module unit-tests against a mocked judge with no network.
 */
import { CostGuard, approxTokens, estimateCallUsd } from '../costs.js';
import { extractBalanced, fold, mentionsTerm } from '../text.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
  type Query,
  type QueryIntent,
  type QueryPack,
} from '../types.js';

/** The full intent set, in stable order; `local` is gated on geo. */
export const QUERY_INTENTS: QueryIntent[] = [
  'best-of',
  'comparison',
  'problem',
  'trust',
  'local',
];

/** Default number of prompts in a generated pack. */
export const DEFAULT_QUERY_COUNT = 20;

/**
 * Relative weight of each intent when allocating a capped pack. `best-of` is the
 * most rewrite-stable prompt form across engines (Profound fanout study), so it
 * earns the largest share; the rest are equal.
 */
export const INTENT_WEIGHTS: Record<QueryIntent, number> = {
  'best-of': 2,
  comparison: 1,
  problem: 1,
  trust: 1,
  local: 1,
};

/** Which intents apply to this profile - local only when it has a geo. */
export function activeIntents(profile: BrandProfile): QueryIntent[] {
  return QUERY_INTENTS.filter((i) => i !== 'local' || Boolean(profile.geo));
}

/**
 * Split `target` slots across `intents` in proportion to {@link INTENT_WEIGHTS},
 * so `best-of` gets the biggest share. Largest-remainder rounding keeps the sum
 * exactly `target`; ties break by the intents' given order (best-of first).
 */
export function intentQuotas(
  target: number,
  intents: QueryIntent[],
): Record<QueryIntent, number> {
  const quotas = Object.fromEntries(intents.map((i) => [i, 0])) as Record<
    QueryIntent,
    number
  >;
  if (intents.length === 0 || target <= 0) return quotas;

  const totalWeight = intents.reduce((s, i) => s + INTENT_WEIGHTS[i], 0);
  const raw = intents.map((i) => (target * INTENT_WEIGHTS[i]) / totalWeight);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = target - floors.reduce((s, f) => s + f, 0);

  // Hand out the leftover slots to the largest fractional parts first; the
  // stable index tiebreak keeps best-of (index 0) ahead of equal-fraction peers.
  const order = intents
    .map((intent, idx) => ({ intent, idx, frac: raw[idx]! - floors[idx]! }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  intents.forEach((intent, idx) => (quotas[intent] = floors[idx]!));
  for (const { intent } of order) {
    if (remainder <= 0) break;
    quotas[intent] += 1;
    remainder -= 1;
  }
  return quotas;
}

/**
 * Remove prompts that name any competitor. Boundary-aware and Unicode-safe
 * (case/accent-folded), so "Quest" does not knock out "question" but "C++",
 * ".NET", and non-Latin names are still caught (shared matcher).
 */
export function excludeCompetitors(
  prompts: string[],
  competitors: string[],
): string[] {
  const terms = competitors.map((c) => c.trim()).filter(Boolean);
  return prompts.filter((prompt) => {
    const folded = fold(prompt);
    return !terms.some((term) => mentionsTerm(folded, term));
  });
}

/**
 * Parse judge output into prompts keyed by intent. Expects a JSON object
 * `{ intent: string[] }` (optionally fenced); unknown intents are ignored and
 * every requested intent is present (empty when the model omitted it).
 */
export function parseIntentQueries(
  text: string,
  intents: QueryIntent[],
): Record<QueryIntent, string[]> {
  const byIntent: Record<QueryIntent, string[]> = {
    'best-of': [],
    comparison: [],
    problem: [],
    trust: [],
    local: [],
  };

  const json = extractBalanced(text, '{', '}');
  if (json === null) return byIntent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return byIntent;
  }
  if (!parsed || typeof parsed !== 'object') return byIntent;

  const obj = parsed as Record<string, unknown>;
  for (const intent of intents) {
    const value = obj[intent];
    if (Array.isArray(value)) {
      byIntent[intent] = value
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return byIntent;
}

export interface BuildPackInput {
  domain: string;
  byIntent: Record<QueryIntent, string[]>;
  intents: QueryIntent[];
  competitors: string[];
  target: number;
  generatedAt: string;
}

/**
 * Assemble a capped, competitor-free {@link QueryPack} from parsed prompts.
 *
 * Prompts are interleaved by {@link INTENT_WEIGHTS} using smooth weighted
 * round-robin, so best-of is over-represented but SPREAD through the pack rather
 * than clustered. This matters because a cost-capped or otherwise truncated run
 * asks prompts in pack order and stops partway: an interleaved pack keeps that
 * partial run balanced across intents (a front-loaded best-of block would skew
 * the headline score toward one intent). Each prompt gets a stable `q<n>` id.
 */
export function buildQueryPack(input: BuildPackInput): QueryPack {
  const { domain, byIntent, intents, competitors, target, generatedAt } = input;

  // Competitor exclusion + de-dupe (across the whole pack), per intent.
  const remaining = new Map<QueryIntent, string[]>();
  const seen = new Set<string>();
  for (const intent of intents) {
    const kept: string[] = [];
    const prompts = excludeCompetitors(byIntent[intent] ?? [], competitors);
    for (const prompt of prompts) {
      const key = prompt.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(prompt);
      }
    }
    remaining.set(intent, kept);
  }

  // Smooth weighted round-robin (nginx-style): each round, add each intent's
  // weight to its credit, pick the highest-credit intent that still has prompts,
  // then subtract the total live weight. Higher-weight intents (best-of) come up
  // more often, evenly spaced; exhausted intents drop out of the weighting, so a
  // short intent never stalls the pack and the fill backfills automatically.
  const credit = new Map<QueryIntent, number>(intents.map((i) => [i, 0]));
  const queries: Query[] = [];
  while (queries.length < target) {
    let liveWeight = 0;
    let pick: QueryIntent | null = null;
    for (const intent of intents) {
      if ((remaining.get(intent)?.length ?? 0) === 0) continue;
      liveWeight += INTENT_WEIGHTS[intent];
      const c = credit.get(intent)! + INTENT_WEIGHTS[intent];
      credit.set(intent, c);
      if (pick === null || c > credit.get(pick)!) pick = intent;
    }
    if (pick === null) break; // every intent is exhausted
    credit.set(pick, credit.get(pick)! - liveWeight);
    const prompt = remaining.get(pick)!.shift()!;
    queries.push({ id: `q${queries.length + 1}`, intent: pick, prompt });
  }

  return { schema_version: SCHEMA_VERSION, domain, queries, generatedAt };
}

/** One-sentence description of each intent, for the generation prompt. */
const INTENT_GUIDANCE: Record<QueryIntent, string> = {
  'best-of': 'shortlist questions ("what are the best ... for ...")',
  comparison: 'questions weighing options or approaches when choosing',
  problem: 'questions describing a problem this product/service solves',
  trust: 'questions about reputation, reliability, or safety',
  local: 'questions scoped to a place ("... near me", "... in <city>")',
};

/**
 * Build the generation prompt. Competitor names are deliberately withheld
 * (they are used only at scoring); the pack builder strips any that slip in.
 * `counts` carries a per-intent target so best-of (the rewrite-stable form) is
 * asked for more than the rest.
 */
function buildGenPrompt(
  profile: BrandProfile,
  intents: QueryIntent[],
  counts: Record<QueryIntent, number>,
  year: string,
): string {
  const facts = [`Brand: ${profile.brand}`];
  if (profile.category) facts.push(`Category: ${profile.category}`);
  if (profile.offerings?.length) {
    facts.push(`Offerings: ${profile.offerings.join(', ')}`);
  }
  if (profile.locale) facts.push(`Locale: ${profile.locale}`);
  if (profile.geo) facts.push(`Location: ${profile.geo}`);

  const intentLines = intents
    .map((i) => `- "${i}" (write ${counts[i]}): ${INTENT_GUIDANCE[i]}`)
    .join('\n');

  return [
    'You are modeling how a real buyer talks to an AI shopping assistant.',
    'Write the number of natural buyer questions shown for EACH intent below.',
    '',
    'Rules for EVERY question:',
    "- Write in the buyer's language, matching the Locale below.",
    '- Make each question completely self-contained: it is sent to the AI on',
    '  its own, with no earlier conversation. Name the product category or type',
    '  explicitly in the question itself.',
    '- No dangling back-references: never write "this brand", "these products",',
    '  "this kind of product", "such products" (or their equivalents in the',
    "  buyer's language) - there is nothing for them to refer to.",
    "- Prefer concrete, specific questions (a real buyer's exact wording, named",
    '  use case or spec) over broad thematic ones - retrieval layers convert',
    '  everything to fact-lookups, so a vague theme scores nothing.',
    '- When a question carries a price or spec constraint (a budget, size, or',
    '  compatibility), also write an UNCONSTRAINED variant of it without that',
    '  limit - engines frequently drop constraints when they rewrite. The pair',
    '  counts toward the number for its intent, never on top of it.',
    '- Keep any location qualifier ("near me", a city) when the question is',
    '  local - those survive engine rewrites.',
    '- Prefer timeless phrasing. If a question does reference a year or time',
    `  period, use the current year (${year}) and NEVER a past year - a stale`,
    '  year ("best phones in 2023") reads as out of date.',
    '- For every intent EXCEPT "trust": write as a shopper who does not yet know',
    `  this brand - do NOT name ${profile.brand}. Never name a competitor.`,
    `- For "trust": name the brand explicitly ("${profile.brand}"), never as`,
    '  "this brand".',
    '',
    facts.join('\n'),
    '',
    'Intents (with how many to write for each):',
    intentLines,
    '',
    'Return ONLY a JSON object mapping each intent string to an array of',
    'question strings, e.g. {"best-of": ["..."], "problem": ["..."]}.',
  ].join('\n');
}

export interface GenerateDeps {
  judge: JudgeClient;
  guard: CostGuard;
  /** Projected setup cost for authorization; defaults to a per-model estimate. */
  projectedCostUsd?: number;
}

export interface GenerateOptions {
  /** Target pack size (default {@link DEFAULT_QUERY_COUNT}). */
  count?: number;
  generatedAt: string;
}

export interface GenerateResult {
  pack: QueryPack;
  /** Set when generation was skipped or failed (cap hit or judge error). */
  skipped?: string;
}

/** Generate a buyer-query pack for a profile via one guarded judge call. */
export async function generateQueries(
  profile: BrandProfile,
  deps: GenerateDeps,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const { judge, guard } = deps;
  const target = opts.count ?? DEFAULT_QUERY_COUNT;
  const intents = activeIntents(profile);
  const emptyPack: QueryPack = {
    schema_version: SCHEMA_VERSION,
    domain: profile.domain,
    queries: [],
    generatedAt: opts.generatedAt,
  };

  // Ask per intent by its weighted quota (best-of gets the most), plus a small
  // buffer so competitor-stripping and de-dupe do not shrink the pack below
  // target. The pack still caps at target, so the buffer is over-generation,
  // never extra billed prompts in the pack.
  const quotas = intentQuotas(target, intents);
  const counts = Object.fromEntries(
    intents.map((i) => [i, quotas[i] + 1]),
  ) as Record<QueryIntent, number>;
  // Current year from the injected clock (deterministic in tests), so any year
  // the model reaches for is the current one, not its training-cutoff default.
  const year = opts.generatedAt.slice(0, 4);
  const prompt = buildGenPrompt(profile, intents, counts, year);
  // Scale the output budget with how many questions we ask (weighting + the +1
  // buffer + paired variants all inflate it), plus headroom for JSON structure
  // and verbose (non-English) phrasing. A fixed budget truncated a large pack
  // mid-JSON, which parses to an EMPTY pack; ~60 tokens/question keeps room.
  const requested = intents.reduce((sum, i) => sum + counts[i], 0);
  const maxTokens = Math.max(900, requested * 60);
  const projected =
    deps.projectedCostUsd ??
    estimateCallUsd(judge.model, approxTokens(prompt), maxTokens);
  if (!guard.authorize(projected, 'setup')) {
    return { pack: emptyPack, skipped: 'setup cost cap reached' };
  }

  try {
    const res = await judge.complete(prompt, { maxTokens });
    guard.record(res.costUsd, 'setup');
    const byIntent = parseIntentQueries(res.text, intents);
    const pack = buildQueryPack({
      domain: profile.domain,
      byIntent,
      intents,
      competitors: profile.competitors,
      target,
      generatedAt: opts.generatedAt,
    });
    return { pack };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { pack: emptyPack, skipped: `judge error: ${reason}` };
  }
}
