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

/** Which intents apply to this profile - local only when it has a geo. */
export function activeIntents(profile: BrandProfile): QueryIntent[] {
  return QUERY_INTENTS.filter((i) => i !== 'local' || Boolean(profile.geo));
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
 * Prompts are taken round-robin across intents so a capped pack stays balanced,
 * and each gets a stable `q<n>` id.
 */
export function buildQueryPack(input: BuildPackInput): QueryPack {
  const { domain, byIntent, intents, competitors, target, generatedAt } = input;

  // Competitor exclusion + de-dupe (across the whole pack), per intent.
  const cleaned = new Map<QueryIntent, string[]>();
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
    cleaned.set(intent, kept);
  }

  // Round-robin across intents up to the target count.
  const queries: Query[] = [];
  const cursors = new Map<QueryIntent, number>(intents.map((i) => [i, 0]));
  let progressed = true;
  while (queries.length < target && progressed) {
    progressed = false;
    for (const intent of intents) {
      if (queries.length >= target) break;
      const list = cleaned.get(intent) ?? [];
      const cursor = cursors.get(intent) ?? 0;
      const prompt = list[cursor];
      if (prompt !== undefined) {
        queries.push({ id: `q${queries.length + 1}`, intent, prompt });
        cursors.set(intent, cursor + 1);
        progressed = true;
      }
    }
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
 */
function buildGenPrompt(
  profile: BrandProfile,
  intents: QueryIntent[],
  perIntent: number,
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
    .map((i) => `- "${i}": ${INTENT_GUIDANCE[i]}`)
    .join('\n');

  return [
    'You are modeling how a real buyer talks to an AI shopping assistant.',
    `Write ${perIntent} natural buyer questions for EACH intent below.`,
    '',
    'Rules for EVERY question:',
    "- Write in the buyer's language, matching the Locale below.",
    '- Make each question completely self-contained: it is sent to the AI on',
    '  its own, with no earlier conversation. Name the product category or type',
    '  explicitly in the question itself.',
    '- No dangling back-references: never write "this brand", "these products",',
    '  "this kind of product", "such products" (or their equivalents in the',
    "  buyer's language) - there is nothing for them to refer to.",
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
    'Intents:',
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

  const perIntent = Math.ceil(target / intents.length);
  // Current year from the injected clock (deterministic in tests), so any year
  // the model reaches for is the current one, not its training-cutoff default.
  const year = opts.generatedAt.slice(0, 4);
  const prompt = buildGenPrompt(profile, intents, perIntent, year);
  const maxTokens = 900;
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
