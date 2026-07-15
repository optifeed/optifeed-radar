/**
 * Competitor discovery: the ONE judge-model call M4 makes (M4).
 *
 * Billed to the cost guard's setup budget (hard rule #5). It never throws - a
 * cap hit or a judge error degrades to an empty competitor list with a reason,
 * so discovery always returns a usable profile.
 */
import { CostGuard, estimateJudgeCallUsd } from '../costs.js';
import type { JudgeClient } from '../types.js';

/** Upper bound on competitors we keep from one call. */
const MAX_COMPETITORS = 8;

export interface CompetitorInput {
  brand: string;
  category?: string;
  offerings?: string[];
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
  const parts = [`Brand: ${input.brand}`];
  if (input.category) parts.push(`Category: ${input.category}`);
  if (input.offerings?.length) {
    parts.push(`Offerings: ${input.offerings.join(', ')}`);
  }
  return [
    'You are helping map a market. Given the brand below, list its main direct',
    'competitors (rival brands a shopper would compare it against).',
    '',
    parts.join('\n'),
    '',
    'Return ONLY a JSON array of competitor brand names, e.g. ["Foo", "Bar"].',
    'No commentary. Do not include the brand itself.',
  ].join('\n');
}

/**
 * Parse a competitor list from model output. Handles a JSON array or a
 * newline/comma list with bullets or numbering (lesson #4: parse real shapes).
 */
export function parseCompetitors(text: string): string[] {
  const trimmed = text.trim();

  // Prefer a JSON array if the model returned one (possibly fenced).
  const jsonStart = trimmed.indexOf('[');
  if (jsonStart !== -1) {
    const candidate = trimmed.slice(jsonStart, trimmed.lastIndexOf(']') + 1);
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

function clean(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out.slice(0, MAX_COMPETITORS);
}

/** Discover competitor brand names via one guarded judge call. */
export async function discoverCompetitors(
  input: CompetitorInput,
  deps: CompetitorDeps,
): Promise<CompetitorResult> {
  const { judge, guard } = deps;
  const projected = deps.projectedCostUsd ?? estimateJudgeCallUsd(judge.model);

  if (!guard.authorize(projected, 'setup')) {
    return { competitors: [], skipped: 'setup cost cap reached' };
  }

  try {
    const res = await judge.complete(buildPrompt(input), { maxTokens: 300 });
    guard.record(res.costUsd, 'setup');
    return { competitors: parseCompetitors(res.text) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { competitors: [], skipped: `judge error: ${reason}` };
  }
}
