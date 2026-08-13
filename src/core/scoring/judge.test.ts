import { describe, expect, it } from 'vitest';
import {
  CostGuard,
  REASONING_RESERVE_TOKENS,
  estimateCallUsd,
  judgeMaxTokens,
} from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type JudgeClient,
  type MentionResult,
} from '../types.js';
import { parseVerdict, refineAmbiguous } from './judge.js';

const profile: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'orange.example',
  brand: 'Orange',
  aliases: [],
  competitors: [],
};

function answer(text: string): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt: 'q',
    text,
    model: 'gpt-4o',
    costUsd: 0,
    ts: '2026-07-15T00:00:00.000Z',
  };
}

function ambiguousMention(over: Partial<MentionResult> = {}): MentionResult {
  return {
    engine: 'openai',
    prompt: 'q',
    mentioned: true,
    position: 1,
    sentiment: 'neutral',
    entities: ['Orange'],
    citedDomains: [],
    ambiguous: true,
    ...over,
  };
}

function countingJudge(text: string): JudgeClient & { calls: number } {
  return {
    calls: 0,
    model: 'gpt-4o-mini',
    async complete() {
      this.calls += 1;
      return { text, costUsd: 0.001, model: 'gpt-4o-mini' };
    },
  };
}

/** A judge that always fails, counting how many times it was asked. */
function throwingJudge(): JudgeClient & { calls: number } {
  return {
    calls: 0,
    model: 'gpt-4o-mini',
    async complete() {
      this.calls += 1;
      throw new Error('HTTP 429: rate limit');
    },
  };
}

/** A judge that records the token budget it was given. */
function budgetJudge(
  text: string,
): JudgeClient & { maxTokens: (number | undefined)[] } {
  const maxTokens: (number | undefined)[] = [];
  return {
    maxTokens,
    model: 'gpt-4o-mini',
    async complete(_prompt, opts) {
      maxTokens.push(opts?.maxTokens);
      return { text, costUsd: 0.001, model: 'gpt-4o-mini' };
    },
  };
}

describe('parseVerdict', () => {
  it('parses the verdict object despite trailing prose braces', () => {
    const v = parseVerdict(
      '{"mentioned": true, "sentiment": "positive"} note {x}',
    );
    expect(v.mentioned).toBe(true);
    expect(v.sentiment).toBe('positive');
  });
});

describe('refineAmbiguous (judge pass 2)', () => {
  it('caps judge calls at 30% of all answers', async () => {
    const results = Array.from({ length: 10 }, () => ambiguousMention());
    const answers = Array.from({ length: 10 }, () => answer('orange juice'));
    const judge = countingJudge('{"mentioned": false}');
    const guard = new CostGuard();

    const out = await refineAmbiguous(results, answers, profile, {
      judge,
      guard,
    });

    expect(judge.calls).toBe(3); // floor(10 * 0.30)
    expect(out.judged).toBe(3);
    expect(out.results.filter((r) => r.judged)).toHaveLength(3);
    // Unjudged ambiguous results are left untouched.
    expect(out.results.filter((r) => r.ambiguous && !r.judged)).toHaveLength(7);
  });

  it('lets the judge overturn a false-positive generic-word match', async () => {
    const results = [ambiguousMention()];
    const answers = [answer('I love fresh orange juice in the morning.')];
    const judge = countingJudge('{"mentioned": false}');

    const out = await refineAmbiguous(
      results,
      answers,
      profile,
      { judge, guard: new CostGuard() },
      { judgeRateCap: 1 }, // full cap so a single-answer list is judged
    );

    const r = out.results[0]!;
    expect(r.mentioned).toBe(false);
    expect(r.position).toBeNull();
    expect(r.entities).toEqual([]);
    expect(r.judged).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it('confirms a real mention and refines its sentiment', async () => {
    const results = [ambiguousMention()];
    const answers = [answer('Orange is the carrier I recommend.')];
    const judge = countingJudge('{"mentioned": true, "sentiment": "positive"}');

    const out = await refineAmbiguous(
      results,
      answers,
      profile,
      { judge, guard: new CostGuard() },
      { judgeRateCap: 1 },
    );

    const r = out.results[0]!;
    expect(r.mentioned).toBe(true);
    expect(r.sentiment).toBe('positive');
    expect(r.judged).toBe(true);
  });

  it('stops mid-pass when the cost cap is hit (never throws)', async () => {
    const results = Array.from({ length: 10 }, () => ambiguousMention());
    const answers = Array.from({ length: 10 }, () => answer('orange juice'));
    const judge = countingJudge('{"mentioned": false}');
    const guard = new CostGuard({ maxCostUsd: 0.0015 }); // room for one call

    const out = await refineAmbiguous(results, answers, profile, {
      judge,
      guard,
      projectedCostUsd: 0.001,
    });

    expect(judge.calls).toBe(1);
    expect(out.judged).toBe(1);
    expect(guard.costCapped).toBe(true);
  });

  it('authorizes a long answer against its real input size', async () => {
    const longText = 'orange juice is nice. '.repeat(400); // ~8800 chars
    const results = [ambiguousMention()];
    const answers = [answer(longText)];
    const judge = countingJudge('{"mentioned": false}');
    // The old fixed 700-input-token estimate would fit; the real ~2000+ tokens
    // of embedded answer text do not, so the guard must stop it.
    const guard = new CostGuard({ maxCostUsd: 0.0002 });

    const out = await refineAmbiguous(
      results,
      answers,
      profile,
      { judge, guard },
      { judgeRateCap: 1 },
    );

    expect(judge.calls).toBe(0);
    expect(out.judged).toBe(0);
    expect(guard.costCapped).toBe(true);
  });

  it('makes no judge calls when nothing is ambiguous', async () => {
    const results = [ambiguousMention({ ambiguous: false })];
    const judge = countingJudge('{"mentioned": false}');

    const out = await refineAmbiguous(results, [answer('x')], profile, {
      judge,
      guard: new CostGuard(),
    });

    expect(judge.calls).toBe(0);
    expect(out.judged).toBe(0);
  });

  // A 200 with no text is a FAILED call, and this is the one judge site where
  // reading it as data is worse than losing it: `parseVerdict('')` returns its
  // conservative `{mentioned: false}` default, which `applyVerdict` then writes
  // as a CONFIRMED non-mention (brand stripped, `ambiguous: false`, `judged:
  // true`) that moves the headline AI Visibility Score down. An empty call must
  // leave the row exactly as pass 1 read it - the same contract the `catch`
  // path already follows (rule #6).
  it.each([
    ['an empty response', ''],
    ['a whitespace-only response', '  \n\t '],
  ])('leaves the pass-1 reading when the judge returns %s', async (_, text) => {
    const judge = countingJudge(text);
    const guard = new CostGuard();

    const out = await refineAmbiguous(
      [ambiguousMention()],
      [answer('I love fresh orange juice in the morning.')],
      profile,
      { judge, guard },
      { judgeRateCap: 1 },
    );

    expect(judge.calls).toBe(1); // the call happened
    const r = out.results[0]!;
    expect(r.ambiguous).toBe(true); // still unresolved, not a verdict
    expect(r.judged).toBeUndefined();
    expect(r.mentioned).toBe(true); // pass 1's reading, untouched
    expect(r.entities).toEqual(['Orange']);
    expect(out.judged).toBe(0);
    // The call was made and billed, so its cost is booked and its hold freed.
    expect(guard.spendBreakdown.mainUsd).toBeCloseTo(0.001, 10);
  });

  // An empty response is billed like any other, so it must still count against
  // the rate cap: skipping it there would let a judge that returns nothing be
  // called for EVERY ambiguous row, spending 100% of a budget capped at 30%.
  it('stops at the rate cap even when every judge call comes back empty', async () => {
    const results = Array.from({ length: 10 }, () => ambiguousMention());
    const answers = Array.from({ length: 10 }, () => answer('orange juice'));
    const judge = countingJudge('');
    const guard = new CostGuard();

    const out = await refineAmbiguous(results, answers, profile, {
      judge,
      guard,
    });

    expect(judge.calls).toBe(3); // floor(10 * 0.30), as with usable verdicts
    expect(out.judged).toBe(0); // nothing was actually resolved
    expect(out.results.filter((r) => r.judged)).toHaveLength(0);
    expect(guard.spendBreakdown.mainUsd).toBeCloseTo(0.003, 10);
  });

  // A failing judge fails for the WHOLE pass, not for one row: a rate limit or
  // an exhausted quota persists. Left uncounted, a throw costs nothing but a
  // slot it never took, so the loop walks every ambiguous row and sends one
  // doomed request each - the same unbounded-call exposure as the empty
  // response above. A live run on this branch hit exactly this (perplexity,
  // HTTP 429, 5 of 8 prompts answered).
  it('stops at the rate cap when every judge call throws', async () => {
    const results = Array.from({ length: 10 }, () => ambiguousMention());
    const answers = Array.from({ length: 10 }, () => answer('orange juice'));
    const judge = throwingJudge();
    const guard = new CostGuard();

    const out = await refineAmbiguous(results, answers, profile, {
      judge,
      guard,
    });

    expect(judge.calls).toBe(3); // floor(10 * 0.30), not one per row
    // Honesty is unchanged by the bound: every row keeps its pass-1 reading,
    // and a failed call is still settled at zero.
    expect(out.judged).toBe(0);
    expect(out.results.every((r) => r.ambiguous && !r.judged)).toBe(true);
    expect(guard.spendBreakdown.totalUsd).toBe(0);
    expect(guard.costCapped).toBe(false);
  });

  // 60 tokens is an ANSWER budget. On a reasoning judge it is also the whole
  // thinking budget, and thinking goes first - the verdict comes back empty and
  // the row silently keeps its pass-1 value (verified live 2026-08-13).
  it('reserves reasoning headroom in the judge token budget', async () => {
    const judge = budgetJudge('YES');
    const guard = new CostGuard();

    await refineAmbiguous(
      [ambiguousMention()],
      [answer('You could try Acme.')],
      profile,
      { judge, guard },
      { judgeRateCap: 1 },
    );

    expect(judge.maxTokens[0]).toBeGreaterThanOrEqual(REASONING_RESERVE_TOKENS);
  });

  // Bug: `authorize` used to be priced on `judgeMaxTokens(60)` (the raised cap
  // sent to the provider, answer + REASONING_RESERVE_TOKENS), not on the
  // 60-token answer budget the call almost always actually uses. That
  // inflated the reservation ~20x and made a modest --max-cost skip the whole
  // judge pass on its first call. Authorization must be priced on the answer
  // budget so a cap that comfortably covers the real cost still authorizes,
  // even though it falls well short of covering the full reasoning-inflated
  // cap.
  it('authorizes against the answer budget, not the reasoning-inflated cap', async () => {
    const model = 'gpt-5.5'; // wide input/output spread makes the gap unambiguous
    const judge = { ...countingJudge('{"mentioned": false}'), model };

    // Mirror the real prompt shape closely enough to ground the projections
    // (the exact prompt is internal to buildPrompt, but boilerplate + a short
    // answer lands in the same ballpark).
    const promptLike = [
      'A brand named "Orange" may or may not be genuinely referenced',
      'in the answer below. Its name is also a common word, so ignore incidental',
      'uses. Decide whether the brand itself is actually recommended or referred',
      'to as a company/product.',
      '',
      'Answer: """You could try Acme."""',
      '',
      'Reply with ONLY JSON: {"mentioned": true|false, "sentiment":',
      '"positive"|"neutral"|"negative"}.',
    ].join('\n');
    const inputTokens = Math.ceil(promptLike.length / 4); // matches approxTokens
    const answerBudgetUsd = estimateCallUsd(model, inputTokens, 60);
    const fullCapUsd = estimateCallUsd(model, inputTokens, judgeMaxTokens(60));
    // Sanity-check the fixture actually exercises the bug: the two projections
    // must be far enough apart that a cap between them is unambiguous.
    expect(fullCapUsd).toBeGreaterThan(answerBudgetUsd * 10);

    // Comfortably above the answer-budget projection, comfortably below the
    // full-cap one.
    const cap = (answerBudgetUsd + fullCapUsd) / 2;
    const guard = new CostGuard({ maxCostUsd: cap });

    const out = await refineAmbiguous(
      [ambiguousMention()],
      [answer('You could try Acme.')],
      profile,
      { judge, guard },
      { judgeRateCap: 1 },
    );

    expect(judge.calls).toBe(1);
    expect(out.judged).toBe(1);
    expect(guard.costCapped).toBe(false);
  });
});
