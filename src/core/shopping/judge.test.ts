import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { EngineAnswer, JudgeClient } from '../types.js';
import { analyzeProductAnswer, type ProductMention } from './detect.js';
import {
  SHOPPING_JUDGE_RATE_CAP,
  parseProductVerdict,
  refineProductMentions,
} from './judge.js';

function answer(text: string): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt: 'best quiet home espresso machine',
    text,
    model: 'gpt-5.4-mini',
    costUsd: 0.001,
    ts: '2026-07-23T00:00:00.000Z',
  };
}

function judgeReturning(
  text: string,
  costUsd = 0.0002,
): JudgeClient & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    model: 'gpt-5.4-mini',
    calls,
    async complete(prompt) {
      calls.push(prompt);
      return { text, costUsd, model: 'gpt-5.4-mini-2026-01-01' };
    },
  };
}

/** Two ambiguous rows (prose mention, no rank) and their answers. */
function ambiguousPair(): {
  results: ProductMention[];
  answers: EngineAnswer[];
} {
  const answers = [
    answer('People often mention the Aria 2 when talking about espresso.'),
    answer('The Aria 2 comes up a lot in conversation about home machines.'),
  ];
  const results = answers.map((a) =>
    analyzeProductAnswer(a, { name: 'Aria 2' }),
  );
  expect(results.every((r) => r.ambiguous)).toBe(true);
  return { results, answers };
}

describe('parseProductVerdict', () => {
  it('reads a full verdict', () => {
    expect(
      parseProductVerdict(
        '{"mentioned": true, "position": 3, "sentiment": "positive", "recommended": ["Breville Bambino", "Aria 2"]}',
      ),
    ).toEqual({
      mentioned: true,
      position: 3,
      sentiment: 'positive',
      recommended: ['Breville Bambino', 'Aria 2'],
    });
  });

  it('accepts a null position (mentioned but unranked)', () => {
    const verdict = parseProductVerdict(
      '{"mentioned": true, "position": null}',
    );
    expect(verdict?.mentioned).toBe(true);
    expect(verdict?.position).toBeNull();
  });

  it('returns null for output it cannot parse', () => {
    expect(parseProductVerdict('I think so, probably.')).toBeNull();
  });

  it('ignores a nonsense position rather than trusting it', () => {
    const verdict = parseProductVerdict('{"mentioned": true, "position": -2}');
    expect(verdict?.position).toBeNull();
  });
});

describe('refineProductMentions', () => {
  it('judges at most the shopping rate cap of all rows', async () => {
    const answers = Array.from({ length: 4 }, () =>
      answer('People mention the Aria 2 sometimes.'),
    );
    const results = answers.map((a) =>
      analyzeProductAnswer(a, { name: 'Aria 2' }),
    );
    const judge = judgeReturning('{"mentioned": true, "position": 2}');

    const out = await refineProductMentions(results, answers, {
      judge,
      guard: new CostGuard(),
    });

    expect(SHOPPING_JUDGE_RATE_CAP).toBe(0.5);
    expect(out.judged).toBe(2);
    expect(judge.calls).toHaveLength(2);
  });

  it('resolves an ambiguous mention into a real rank', async () => {
    const { results, answers } = ambiguousPair();
    const out = await refineProductMentions(results, answers, {
      judge: judgeReturning(
        '{"mentioned": true, "position": 4, "sentiment": "neutral", "recommended": ["A", "B", "C", "Aria 2"]}',
      ),
      guard: new CostGuard(),
    });
    expect(out.results[0]?.position).toBe(4);
    expect(out.results[0]?.shelf).toEqual(['A', 'B', 'C', 'Aria 2']);
    expect(out.results[0]?.ambiguous).toBe(false);
    expect(out.results[0]?.judged).toBe(true);
  });

  it('clears a mention the judge says is not really the product', async () => {
    const { results, answers } = ambiguousPair();
    const out = await refineProductMentions(results, answers, {
      judge: judgeReturning(
        '{"mentioned": false, "recommended": ["Breville Bambino"]}',
      ),
      guard: new CostGuard(),
    });
    expect(out.results[0]?.mentioned).toBe(false);
    expect(out.results[0]?.position).toBeNull();
    expect(out.results[0]?.entities).not.toContain('Aria 2');
    expect(out.results[0]?.shelf).toEqual(['Breville Bambino']);
  });

  it('stops cleanly when the cost cap refuses the next call', async () => {
    const { results, answers } = ambiguousPair();
    const guard = new CostGuard({ maxCostUsd: 0 });
    const judge = judgeReturning('{"mentioned": true, "position": 1}');

    const out = await refineProductMentions(results, answers, { judge, guard });

    expect(judge.calls).toHaveLength(0);
    expect(out.judged).toBe(0);
    expect(guard.costCapped).toBe(true);
    expect(out.results[0]?.position).toBeNull();
  });

  it('keeps the pass-1 reading when the judge output is unparseable', async () => {
    const { results, answers } = ambiguousPair();
    const out = await refineProductMentions(results, answers, {
      judge: judgeReturning('who can say'),
      guard: new CostGuard(),
    });
    expect(out.results[0]?.mentioned).toBe(true);
    expect(out.results[0]?.position).toBeNull();
    expect(out.judged).toBe(1);
  });

  it('frees the reservation when a judge call throws', async () => {
    const { results, answers } = ambiguousPair();
    const guard = new CostGuard({ maxCostUsd: 1 });
    const judge: JudgeClient = {
      model: 'gpt-5.4-mini',
      async complete() {
        throw new Error('rate limited');
      },
    };

    const out = await refineProductMentions(results, answers, { judge, guard });

    expect(out.judged).toBe(0);
    expect(guard.spendBreakdown.totalUsd).toBe(0);
    expect(guard.costCapped).toBe(false);
    expect(out.results[0]?.ambiguous).toBe(true);
  });

  it('never spends on rows pass 1 already resolved', async () => {
    const clear = answer(
      '1. **Aria 2 Pro** - the pick\n2. **Breville Bambino**',
    );
    const results = [analyzeProductAnswer(clear, { name: 'Aria 2 Pro' })];
    const judge = judgeReturning('{"mentioned": true, "position": 1}');

    const out = await refineProductMentions(results, [clear], {
      judge,
      guard: new CostGuard(),
    });

    expect(judge.calls).toHaveLength(0);
    expect(out.judged).toBe(0);
  });
});
