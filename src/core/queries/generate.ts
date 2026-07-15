/**
 * Query generation (M5): profile -> buyer prompts, via ONE guarded judge call.
 *
 * Pure helpers (intent selection, parsing, competitor exclusion, pack assembly)
 * are separated from the single I/O function `generateQueries`, so the whole
 * module unit-tests against a mocked judge with no network.
 */
import { CostGuard, estimateJudgeCallUsd } from '../costs.js';
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove prompts that name any competitor (word-boundary, case-insensitive). */
export function excludeCompetitors(
  prompts: string[],
  competitors: string[],
): string[] {
  const patterns = competitors
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i'));
  return prompts.filter((p) => !patterns.some((re) => re.test(p)));
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

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return byIntent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
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
    'Write them as a shopper who does not yet know this brand: do NOT name',
    'this brand (except "trust" questions) and never name any competitor.',
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

  const projected = deps.projectedCostUsd ?? estimateJudgeCallUsd(judge.model);
  if (!guard.authorize(projected, 'setup')) {
    return { pack: emptyPack, skipped: 'setup cost cap reached' };
  }

  const perIntent = Math.ceil(target / intents.length);
  try {
    const res = await judge.complete(
      buildGenPrompt(profile, intents, perIntent),
      { maxTokens: 900 },
    );
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
