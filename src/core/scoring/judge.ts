/**
 * Judge pass 2 (M7): refine only the ambiguous pass-1 results, within a budget.
 *
 * Judge calls are capped at 30% of all answers AND gated by the cost guard
 * (main phase). Hitting either bound stops the pass without throwing - the
 * remaining ambiguous results are simply left as pass-1 decided them.
 */
import {
  CostGuard,
  approxTokens,
  estimateCallUsd,
  judgeMaxTokens,
} from '../costs.js';
import { extractBalanced } from '../text.js';
import type {
  BrandProfile,
  EngineAnswer,
  JudgeClient,
  MentionResult,
  Sentiment,
} from '../types.js';

/** Default fraction of answers that may receive a judge call. */
export const JUDGE_RATE_CAP = 0.3;

export interface RefineDeps {
  judge: JudgeClient;
  guard: CostGuard;
  /** Projected per-call cost for authorization; defaults to a per-model estimate. */
  projectedCostUsd?: number;
}

export interface RefineOptions {
  /** Max share of answers judged (default {@link JUDGE_RATE_CAP}). */
  judgeRateCap?: number;
}

export interface RefineResult {
  results: MentionResult[];
  /**
   * Rows a verdict was actually applied to. A call that came back unusable, or
   * failed, is NOT counted here - it resolved nothing - though it does count
   * against the rate cap, which bounds REQUESTS rather than resolutions.
   */
  judged: number;
}

const SENTIMENTS = new Set<Sentiment>(['positive', 'neutral', 'negative']);

interface Verdict {
  mentioned: boolean;
  sentiment?: Sentiment;
}

/** Parse the judge's JSON verdict; defaults conservatively on malformed output. */
export function parseVerdict(text: string): Verdict {
  const json = extractBalanced(text, '{', '}');
  if (json === null) return { mentioned: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { mentioned: false };
  }
  if (!parsed || typeof parsed !== 'object') return { mentioned: false };
  const obj = parsed as Record<string, unknown>;
  const sentiment =
    typeof obj.sentiment === 'string' &&
    SENTIMENTS.has(obj.sentiment as Sentiment)
      ? (obj.sentiment as Sentiment)
      : undefined;
  return {
    mentioned: obj.mentioned === true,
    ...(sentiment ? { sentiment } : {}),
  };
}

function buildPrompt(answer: EngineAnswer, profile: BrandProfile): string {
  return [
    `A brand named "${profile.brand}" may or may not be genuinely referenced`,
    'in the answer below. Its name is also a common word, so ignore incidental',
    'uses. Decide whether the brand itself is actually recommended or referred',
    'to as a company/product.',
    '',
    `Answer: """${answer.text}"""`,
    '',
    'Reply with ONLY JSON: {"mentioned": true|false, "sentiment":',
    '"positive"|"neutral"|"negative"}.',
  ].join('\n');
}

/**
 * Re-judge the ambiguous results (up to the rate cap and the cost cap),
 * returning a new results array plus how many were judged.
 */
export async function refineAmbiguous(
  results: MentionResult[],
  answers: EngineAnswer[],
  profile: BrandProfile,
  deps: RefineDeps,
  opts: RefineOptions = {},
): Promise<RefineResult> {
  const { judge, guard } = deps;
  const cap = opts.judgeRateCap ?? JUDGE_RATE_CAP;
  const maxJudge = Math.floor(results.length * cap);
  const refined = [...results];
  let judged = 0;
  /**
   * Judge REQUESTS made - what the rate cap actually bounds. Counted once, at
   * the point the call is committed to, so no outcome can forget to count
   * itself.
   *
   * Deliberately not "rows resolved": a judge that returns an empty body, or
   * throws, resolves nothing, so a cap counting resolutions would let a broken
   * judge be asked once per ambiguous row - the whole answer set, under a cap
   * set at 30%. Judge failures are rarely per-row: a rate limit or an exhausted
   * quota persists for the whole pass (seen live on this branch as `perplexity
   * (HTTP 429 rate limit)`), so "retry until something works" means hammering a
   * provider that is already asking us to slow down.
   *
   * The trade-off, chosen knowingly: a TRANSIENT failure now consumes a slot a
   * later good call could have used, so a flaky provider yields a little less
   * refinement. That is the cheaper side. The cap is a bound on requests, and
   * unjudged rows degrade honestly (they keep their pass-1 reading and stay
   * `ambiguous`), while an unbounded loop against a failing provider does not
   * degrade at all - it just keeps asking. Do not "fix" this back to counting
   * only successful calls.
   */
  let attempted = 0;

  if (maxJudge === 0) return { results: refined, judged };

  // A verdict is a word; judgeMaxTokens adds the reasoning reserve so a thinking
  // judge is not out of budget before it writes that word.
  const answerTokens = 60;
  const maxTokens = judgeMaxTokens(answerTokens);
  for (let i = 0; i < refined.length && attempted < maxJudge; i++) {
    const result = refined[i];
    const answer = answers[i];
    if (!result?.ambiguous || !answer) continue;

    // Project against the real prompt size (it embeds the full answer text),
    // so a long answer cannot slip past the cost cap on a fixed under-estimate.
    const prompt = buildPrompt(answer, profile);
    // Priced on the ANSWER budget, not `maxTokens`. The cap carries reasoning
    // headroom the call is ALLOWED to use but almost never does, so reserving
    // against it over-reserved by ~20x and made a tight --max-cost skip the
    // whole judge pass. Overshoot is bounded by one call's thinking and
    // `settle` books the provider's real reported cost, which is the
    // documented --max-cost contract. See judgeMaxTokens in costs.ts.
    const projected =
      deps.projectedCostUsd ??
      estimateCallUsd(judge.model, approxTokens(prompt), answerTokens);
    if (!guard.authorize(projected, 'main')) break; // cost-capped: stop cleanly
    // Counted HERE, before the await: the request is now committed, and every
    // outcome below (verdict, empty body, throw) is one request against the
    // cap. Incrementing on the outcome paths instead is how the throw path came
    // to be uncounted.
    attempted += 1;

    let verdict: Verdict;
    try {
      const res = await judge.complete(prompt, { maxTokens });
      // settle, not record: `authorize` reserved `projected` (see CostGuard).
      guard.settle(projected, res.costUsd, 'main');
      // A 200 with no text is a FAILED call (a reasoning judge that spent the
      // whole cap on private thinking), not a verdict. It must be treated as
      // one HERE, before parsing: `parseVerdict('')` returns its conservative
      // `{mentioned: false}` default, which `applyVerdict` would then write as
      // a CONFIRMED non-mention - brand stripped, `ambiguous: false`, `judged:
      // true` - moving the headline score down on the strength of a call that
      // said nothing. Leaving the row as pass 1 decided it is what every other
      // failure on this loop does (rule #6).
      if (res.text.trim() === '') continue;
      verdict = parseVerdict(res.text);
    } catch {
      guard.settle(projected, 0, 'main'); // failed call cost nothing
      // A judge error leaves this result as pass 1 decided it.
      continue;
    }

    refined[i] = applyVerdict(result, verdict, profile.brand);
    judged += 1;
  }

  return { results: refined, judged };
}

/** Apply a judge verdict to a pass-1 result. */
function applyVerdict(
  result: MentionResult,
  verdict: Verdict,
  brand: string,
): MentionResult {
  if (!verdict.mentioned) {
    return {
      ...result,
      mentioned: false,
      position: null,
      entities: result.entities.filter((e) => e !== brand),
      ambiguous: false,
      judged: true,
    };
  }
  return {
    ...result,
    mentioned: true,
    sentiment: verdict.sentiment ?? result.sentiment,
    ambiguous: false,
    judged: true,
  };
}
