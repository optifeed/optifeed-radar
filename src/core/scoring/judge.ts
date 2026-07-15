/**
 * Judge pass 2 (M7): refine only the ambiguous pass-1 results, within a budget.
 *
 * Judge calls are capped at 30% of all answers AND gated by the cost guard
 * (main phase). Hitting either bound stops the pass without throwing - the
 * remaining ambiguous results are simply left as pass-1 decided them.
 */
import { CostGuard, estimateJudgeCallUsd } from '../costs.js';
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
  judged: number;
}

const SENTIMENTS = new Set<Sentiment>(['positive', 'neutral', 'negative']);

interface Verdict {
  mentioned: boolean;
  sentiment?: Sentiment;
}

/** Parse the judge's JSON verdict; defaults conservatively on malformed output. */
export function parseVerdict(text: string): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { mentioned: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
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

  if (maxJudge === 0) return { results: refined, judged };

  const projected = deps.projectedCostUsd ?? estimateJudgeCallUsd(judge.model);

  for (let i = 0; i < refined.length && judged < maxJudge; i++) {
    const result = refined[i];
    const answer = answers[i];
    if (!result?.ambiguous || !answer) continue;

    if (!guard.authorize(projected, 'main')) break; // cost-capped: stop cleanly

    let verdict: Verdict;
    try {
      const res = await judge.complete(buildPrompt(answer, profile), {
        maxTokens: 60,
      });
      guard.record(res.costUsd, 'main');
      verdict = parseVerdict(res.text);
    } catch {
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
