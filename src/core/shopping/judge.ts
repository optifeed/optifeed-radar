/**
 * Judge pass 2 for products (M12a): resolve only the rows pass 1 could not.
 *
 * Same contract as M7's judge pass (`core/scoring/judge.ts`) with one deliberate
 * difference: the rate cap is 50%, not 30%. Product names are messier than brand
 * names - single-token names, model numbers, engines that recommend in prose -
 * so more rows land ambiguous and the budget to resolve them is larger. What is
 * actually spent is reported in the run's sampling metadata (rule #6).
 *
 * Hitting either bound (the rate cap or the cost cap) stops the pass without
 * throwing; unjudged rows simply stay as pass 1 read them.
 */
import { CostGuard, approxTokens, estimateCallUsd } from '../costs.js';
import { extractBalanced } from '../text.js';
import type { EngineAnswer, JudgeClient, Sentiment } from '../types.js';
import { shelfEntryIsProduct, type ProductMention } from './detect.js';

/**
 * Fraction of product rows that may receive a judge call. Higher than the brand
 * check's {@link JUDGE_RATE_CAP} for the reason above; the cost guard still
 * bounds the money regardless of this number.
 */
export const SHOPPING_JUDGE_RATE_CAP = 0.5;

/** Most recommendations we accept back from one verdict. */
const MAX_RECOMMENDED = 10;

export interface RefineProductsDeps {
  judge: JudgeClient;
  guard: CostGuard;
  /** Projected per-call cost for authorization; defaults to a per-model estimate. */
  projectedCostUsd?: number;
}

export interface RefineProductsOptions {
  /** Max share of rows judged (default {@link SHOPPING_JUDGE_RATE_CAP}). */
  judgeRateCap?: number;
}

export interface RefineProductsResult {
  results: ProductMention[];
  /** Rows that actually received a judge call (what the run paid for). */
  judged: number;
}

const SENTIMENTS = new Set<Sentiment>(['positive', 'neutral', 'negative']);

/** What the judge decided about one product in one answer. */
export interface ProductVerdict {
  mentioned: boolean;
  /** 1-based rank on the answer's list, or null when it named no order. */
  position: number | null;
  sentiment?: Sentiment;
  /** The products the answer recommends, in order, as the judge read them. */
  recommended?: string[];
}

/**
 * Parse the judge's JSON verdict, or `null` when the output is not a verdict at
 * all.
 *
 * `null` matters: unlike the brand judge, a product verdict must not default to
 * "not mentioned" on unparseable output. Pass 1 already found a real term match
 * for most of these rows, and silently overwriting it with `false` would delete
 * a mention the answer genuinely contains.
 */
export function parseProductVerdict(text: string): ProductVerdict | null {
  const json = extractBalanced(text, '{', '}');
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.mentioned !== 'boolean') return null;

  // A position is only trusted when it is a positive integer; anything else
  // (0, -2, "third", 99.5) reads as "no rank stated" rather than as data.
  const rawPosition = obj.position;
  const position =
    typeof rawPosition === 'number' &&
    Number.isInteger(rawPosition) &&
    rawPosition > 0
      ? rawPosition
      : null;

  const sentiment =
    typeof obj.sentiment === 'string' &&
    SENTIMENTS.has(obj.sentiment as Sentiment)
      ? (obj.sentiment as Sentiment)
      : undefined;

  const recommended = Array.isArray(obj.recommended)
    ? obj.recommended
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_RECOMMENDED)
    : undefined;

  return {
    mentioned: obj.mentioned,
    position,
    ...(sentiment ? { sentiment } : {}),
    ...(recommended ? { recommended } : {}),
  };
}

function buildPrompt(answer: EngineAnswer, product: string): string {
  return [
    `A shopper asked: "${answer.prompt}"`,
    '',
    `Decide how the answer below treats the product "${product}".`,
    'Product names are easy to confuse with ordinary words and with other',
    'products in the same family, so only count a reference to THIS product.',
    '',
    `Answer: """${answer.text}"""`,
    '',
    'Reply with ONLY JSON:',
    '{"mentioned": true|false, "position": <1-based rank in the answer\'s list',
    'of recommendations, or null if it gives no order>, "sentiment":',
    '"positive"|"neutral"|"negative", "recommended": [product names the answer',
    'recommends, in the order it presents them]}',
  ].join('\n');
}

/**
 * Re-judge the ambiguous product rows (up to the rate cap and the cost cap),
 * returning a new results array plus how many rows were judged.
 *
 * `results[i]` must describe `answers[i]` (one row per product/answer pair).
 */
export async function refineProductMentions(
  results: ProductMention[],
  answers: EngineAnswer[],
  deps: RefineProductsDeps,
  opts: RefineProductsOptions = {},
): Promise<RefineProductsResult> {
  const { judge, guard } = deps;
  const cap = opts.judgeRateCap ?? SHOPPING_JUDGE_RATE_CAP;
  const maxJudge = Math.floor(results.length * cap);
  const refined = [...results];
  let judged = 0;

  if (maxJudge === 0) return { results: refined, judged };

  const maxTokens = 200;
  for (let i = 0; i < refined.length && judged < maxJudge; i++) {
    const result = refined[i];
    const answer = answers[i];
    if (!result?.ambiguous || !answer) continue;

    // Priced against the REAL prompt, which embeds the whole answer text, so a
    // long answer cannot slip past the cap on a fixed under-estimate.
    const prompt = buildPrompt(answer, result.product);
    const projected =
      deps.projectedCostUsd ??
      estimateCallUsd(judge.model, approxTokens(prompt), maxTokens);
    if (!guard.authorize(projected, 'main')) break; // cost-capped: stop cleanly

    let verdict: ProductVerdict | null;
    try {
      const res = await judge.complete(prompt, { maxTokens });
      // settle, not record: `authorize` reserved `projected` (see CostGuard).
      guard.settle(projected, res.costUsd, 'main');
      verdict = parseProductVerdict(res.text);
    } catch {
      guard.settle(projected, 0, 'main'); // a failed call cost nothing
      continue; // leave this row as pass 1 decided it
    }

    // The call happened and was billed, so it counts as judged even when the
    // output was unusable - `judged` reports what the run PAID for, not how
    // many rows changed.
    judged += 1;
    if (verdict) refined[i] = applyVerdict(result, verdict);
  }

  return { results: refined, judged };
}

/** Apply a judge verdict to a pass-1 product row. */
function applyVerdict(
  result: ProductMention,
  verdict: ProductVerdict,
): ProductMention {
  const terms = [result.product];
  const shelf = verdict.recommended ?? result.shelf;
  const others = shelf.filter((entry) => !shelfEntryIsProduct(entry, terms));

  if (!verdict.mentioned) {
    return {
      ...result,
      mentioned: false,
      position: null,
      sentiment: 'neutral',
      entities: others,
      shelf,
      ambiguous: false,
      judged: true,
    };
  }

  return {
    ...result,
    mentioned: true,
    position: verdict.position,
    sentiment: verdict.sentiment ?? result.sentiment,
    entities: [result.product, ...others],
    shelf,
    ambiguous: false,
    judged: true,
  };
}
