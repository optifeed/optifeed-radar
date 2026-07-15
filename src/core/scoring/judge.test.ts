import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
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
});
