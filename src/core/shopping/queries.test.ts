import { describe, expect, it } from 'vitest';
import {
  CostGuard,
  REASONING_RESERVE_TOKENS,
  approxTokens,
  estimateCallUsd,
  judgeMaxTokens,
} from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
  type ProductEntity,
} from '../types.js';
import {
  REPUTATION_PROMPTS_PER_PRODUCT,
  VISIBILITY_PROMPTS_PER_PRODUCT,
  generateProductQueries,
} from './queries.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Coffee',
  aliases: [],
  category: 'home espresso machines',
  locale: 'en-US',
  competitors: ['Breville'],
};

const PRODUCTS: ProductEntity[] = [
  { name: 'Aria 2', descriptor: 'quiet home espresso machine' },
  { name: 'Presto X' },
];

function judgeReturning(text: string): JudgeClient & {
  calls: string[];
  /** The token budget each call was given, for the headroom assertion. */
  maxTokens: (number | undefined)[];
} {
  const calls: string[] = [];
  const maxTokens: (number | undefined)[] = [];
  return {
    model: 'gpt-5.4-mini',
    calls,
    maxTokens,
    async complete(prompt, opts) {
      calls.push(prompt);
      maxTokens.push(opts?.maxTokens);
      return { text, costUsd: 0.0004, model: 'gpt-5.4-mini-2026-01-01' };
    },
  };
}

const GOOD_RESPONSE = JSON.stringify({
  '0': {
    visibility: [
      'best quiet espresso machine for a small kitchen',
      'quiet espresso machine under $500',
      'which espresso machine is quietest',
    ],
    reputation: ['is the Aria 2 worth buying?'],
  },
  '1': {
    visibility: [
      'best espresso machine for beginners',
      'fastest home espresso machine',
      'espresso machine with a built in grinder',
    ],
    reputation: ['Presto X reviews and complaints'],
  },
});

const opts = { generatedAt: '2026-07-23T00:00:00.000Z' };

describe('generateProductQueries', () => {
  it('writes three visibility prompts and one named prompt per product', async () => {
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(GOOD_RESPONSE), guard: new CostGuard() },
      opts,
    );

    expect(VISIBILITY_PROMPTS_PER_PRODUCT).toBe(3);
    const first = result.prompts.filter((p) => p.productIndex === 0);
    expect(first.filter((p) => p.layer === 'visibility')).toHaveLength(3);
    expect(first.filter((p) => p.layer === 'reputation')).toHaveLength(1);
    expect(result.prompts.filter((p) => p.productIndex === 1)).toHaveLength(4);
    // Presto X has no descriptor, so its questions came from the store
    // category - reported, never silent. Aria 2 has one, so it is not named.
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('Presto X');
  });

  it('seeds the judge with the brand category, locale and the descriptors', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);
    await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );
    const prompt = judge.calls[0] ?? '';
    expect(prompt).toContain('home espresso machines');
    expect(prompt).toContain('en-US');
    expect(prompt).toContain('quiet home espresso machine');
    expect(judge.calls).toHaveLength(1);
  });

  // Live, 2026-07-23: an opaque product name with no descriptor ("Zephyr Q9
  // Pro") at an espresso-machine store had the judge invent a robot-vacuum
  // category from the name alone, and the merchant was then scored against
  // questions from a category they do not sell into.
  it('tells the judge not to guess a category from the product name', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);
    await generateProductQueries(
      PROFILE,
      [{ name: 'Zephyr Q9 Pro' }],
      { judge, guard: new CostGuard() },
      opts,
    );
    const prompt = (judge.calls[0] ?? '').toLowerCase();
    expect(prompt).toContain('never guess');
    expect(prompt).toContain('store category');
  });

  it('gives the judge each product resolved subject, so it need not invent one', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);
    await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );
    const prompt = judge.calls[0] ?? '';
    // Aria 2 carries its own descriptor; Presto X has none, so it must be
    // handed the store category rather than left for the model to guess.
    expect(prompt).toContain('Aria 2 (a quiet home espresso machine)');
    expect(prompt).toContain('Presto X (a home espresso machines)');
  });

  it('says which products were measured against the store category', async () => {
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(GOOD_RESPONSE), guard: new CostGuard() },
      opts,
    );
    const notes = result.notes.join(' ');
    expect(notes).toContain('Presto X');
    expect(notes).toContain('home espresso machines');
    expect(notes).not.toContain('Aria 2');
  });

  it('keys prompts by product index, not by the name the judge echoed', async () => {
    const echoedWrong = JSON.stringify({
      '0': {
        visibility: ['best quiet espresso machine'],
        reputation: ['is the ARIA-2 (Aria II) any good?'],
      },
      'Presto 10': { visibility: ['nonsense'], reputation: ['nonsense'] },
    });
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(echoedWrong), guard: new CostGuard() },
      opts,
    );
    const forFirst = result.prompts.filter((p) => p.productIndex === 0);
    expect(
      forFirst.some((p) => p.prompt === 'best quiet espresso machine'),
    ).toBe(true);
    expect(result.prompts.some((p) => p.prompt === 'nonsense')).toBe(false);
  });

  it('drops a visibility prompt that names the product and backfills it', async () => {
    const namesProduct = JSON.stringify({
      '0': {
        visibility: [
          'is the Aria 2 the best quiet espresso machine',
          'best quiet espresso machine for a small kitchen',
          'quiet espresso machine under $500',
        ],
        reputation: ['is the Aria 2 worth buying?'],
      },
    });
    const result = await generateProductQueries(
      PROFILE,
      [PRODUCTS[0]!],
      { judge: judgeReturning(namesProduct), guard: new CostGuard() },
      opts,
    );
    const visibility = result.prompts.filter((p) => p.layer === 'visibility');
    expect(visibility).toHaveLength(3);
    expect(visibility.every((p) => !p.prompt.includes('Aria 2'))).toBe(true);
  });

  it('replaces a reputation prompt that never names the product', async () => {
    const unnamed = JSON.stringify({
      '0': {
        visibility: ['best quiet espresso machine'],
        reputation: ['is it any good?'],
      },
    });
    const result = await generateProductQueries(
      PROFILE,
      [PRODUCTS[0]!],
      { judge: judgeReturning(unnamed), guard: new CostGuard() },
      opts,
    );
    const reputation = result.prompts.filter((p) => p.layer === 'reputation');
    expect(reputation).toHaveLength(1);
    expect(reputation[0]?.prompt).toContain('Aria 2');
  });

  // Regression coverage for the answer-vs-cap pricing bug fixed alongside this
  // (full rationale in scoring/judge.ts): `authorize` must be priced on the
  // answer budget, not `judgeMaxTokens(answerTokens)`. A cap that only covers
  // the former must still authorize the call.
  it('authorizes against the answer budget, not the reasoning-inflated cap', async () => {
    const model = 'gpt-5.5'; // wide input/output spread makes the gap unambiguous
    const makeJudge = (): JudgeClient & { calls: string[] } => {
      const calls: string[] = [];
      return {
        model,
        calls,
        async complete(prompt) {
          calls.push(prompt);
          return { text: GOOD_RESPONSE, costUsd: 0.001, model };
        },
      };
    };
    const answerTokens = Math.max(
      600,
      PRODUCTS.length *
        (VISIBILITY_PROMPTS_PER_PRODUCT + REPUTATION_PROMPTS_PER_PRODUCT) *
        45,
    );

    // Capture the real prompt so the projections below are grounded in what
    // the call actually sends, not a hand-typed approximation.
    const probe = makeJudge();
    await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: probe, guard: new CostGuard({ maxSetupCostUsd: 10 }) },
      opts,
    );
    const inputTokens = approxTokens(probe.calls[0]!);

    const answerBudgetUsd = estimateCallUsd(model, inputTokens, answerTokens);
    const fullCapUsd = estimateCallUsd(
      model,
      inputTokens,
      judgeMaxTokens(answerTokens),
    );
    // Self-check: if a future pricing-table edit closes this gap, fail loud
    // rather than silently letting the cap below stop discriminating.
    expect(fullCapUsd).toBeGreaterThan(answerBudgetUsd * 5);

    const judge = makeJudge();
    // Comfortably above the answer-budget projection, comfortably below the
    // full-cap one.
    const guard = new CostGuard({
      maxSetupCostUsd: (answerBudgetUsd + fullCapUsd) / 2,
    });

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(judge.calls).toHaveLength(1);
    expect(result.notes.join(' ')).not.toContain('cost cap');
    expect(guard.costCapped).toBe(false);
  });

  // The other half of the token-budget invariant, and the half the authorize
  // test cannot see (pricing is identical either way): the budget SENT to the
  // provider must be sized through `judgeMaxTokens`. Without the reserve, a
  // thinking judge spends the whole cap on private reasoning and returns
  // nothing - which is exactly the "templates for everyone" failure below.
  it('reserves reasoning headroom in the judge token budget', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);

    await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(judge.maxTokens[0]).toBeGreaterThanOrEqual(REASONING_RESERVE_TOKENS);
  });

  // A 200 with no text is a FAILED call, not "this store has no questions".
  // Every product then falls through to templates, and a silent fallback is
  // the exact hazard the token budget above guards against - so the run must
  // SAY the questions are generic (rule #6), the same way the cap-refused and
  // judge-threw paths already do.
  it('falls back to templates and says so when the judge returns an empty response', async () => {
    const judge = judgeReturning('');
    const guard = new CostGuard();

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(judge.calls).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('empty response');
    expect(result.notes.join(' ')).toContain('template');
    // Templates still cover both layers for both products.
    expect(result.prompts).toHaveLength(
      PRODUCTS.length *
        (VISIBILITY_PROMPTS_PER_PRODUCT + REPUTATION_PROMPTS_PER_PRODUCT),
    );
    expect(result.prompts.map((p) => p.prompt)).toContain(
      'best quiet home espresso machine',
    );
    // The call happened, so its cost is booked and its hold freed.
    expect(guard.spendBreakdown.setupUsd).toBeCloseTo(0.0004, 10);
  });

  it('falls back to templates and says so when the response has no usable questions', async () => {
    const judge = judgeReturning('Sorry, I cannot help with that request.');

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(result.notes.join(' ')).toContain('no usable');
    expect(result.notes.join(' ')).toContain('template');
    expect(result.prompts.length).toBeGreaterThan(0);
  });

  it('falls back to templates and says so when the response is valid JSON with no questions', async () => {
    const judge = judgeReturning(
      JSON.stringify({ '0': { visibility: [], reputation: [] } }),
    );

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(result.notes.join(' ')).toContain('no usable');
  });

  // The all-or-nothing check above passes as soon as ONE product got usable
  // questions, so a response covering product 0 and skipping product 1 was
  // reported as a clean success while product 1 was scored on generic
  // templates. Which products fell back is the actionable part - "some
  // products did" is not.
  it('names the products the judge did not cover', async () => {
    const coversFirstOnly = JSON.stringify({
      '0': {
        visibility: [
          'best quiet espresso machine for a small kitchen',
          'quiet espresso machine under $500',
          'which espresso machine is quietest',
        ],
        reputation: ['is the Aria 2 worth buying?'],
      },
    });

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(coversFirstOnly), guard: new CostGuard() },
      opts,
    );

    const note = result.notes.find((n) => n.includes('template'));
    expect(note).toBeDefined();
    expect(note).toContain('Presto X');
    // Aria 2 was covered; naming it would send the user after a fault that is
    // not there.
    expect(note).not.toContain('Aria 2');
    // The whole-call notes stay quiet: the call itself worked.
    expect(result.notes.join(' ')).not.toContain('no usable');
    expect(result.notes.join(' ')).not.toContain('empty response');
  });

  // A product can get SOME questions from the judge and the rest from
  // templates - here two of three visibility prompts survive and a template
  // backfills the one that named the product. That product's category score
  // is then part generic, which is the same hazard at a smaller size, so it
  // is reported too.
  it('reports a product whose questions were only partly judge-written', async () => {
    const namesProduct = JSON.stringify({
      '0': {
        visibility: [
          'is the Aria 2 the best quiet espresso machine',
          'best quiet espresso machine for a small kitchen',
          'quiet espresso machine under $500',
        ],
        reputation: ['is the Aria 2 worth buying?'],
      },
    });

    const result = await generateProductQueries(
      PROFILE,
      [PRODUCTS[0]!],
      { judge: judgeReturning(namesProduct), guard: new CostGuard() },
      opts,
    );

    expect(result.notes.find((n) => n.includes('template'))).toContain(
      'Aria 2',
    );
  });

  it('says nothing about templates when the judge answered usably', async () => {
    const judge = judgeReturning(GOOD_RESPONSE);

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(result.notes.join(' ')).not.toContain('empty response');
    expect(result.notes.join(' ')).not.toContain('no usable');
    // No false positive: every prompt for both products came from the judge,
    // so nothing may claim a template was used.
    expect(result.notes.join(' ')).not.toContain('template');
  });

  // Every product falls back here, and the whole-call note already says why.
  // Repeating it once per product would bury the cause under a list.
  it('does not add a per-product note when the whole call failed', async () => {
    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge: judgeReturning(''), guard: new CostGuard() },
      opts,
    );

    expect(result.notes.filter((n) => n.includes('template'))).toHaveLength(1);
  });

  it('falls back to templates and says so when the setup cap refuses the call', async () => {
    const guard = new CostGuard({ maxSetupCostUsd: 0 });
    const judge = judgeReturning(GOOD_RESPONSE);

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(judge.calls).toHaveLength(0);
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.prompts.filter((p) => p.layer === 'reputation')).toHaveLength(
      2,
    );
    expect(result.notes.join(' ')).toContain('cost cap');
  });

  it('falls back to templates and frees the hold when the judge throws', async () => {
    const guard = new CostGuard({ maxSetupCostUsd: 1 });
    const judge: JudgeClient = {
      model: 'gpt-5.4-mini',
      async complete() {
        throw new Error('upstream 500');
      },
    };

    const result = await generateProductQueries(
      PROFILE,
      PRODUCTS,
      { judge, guard },
      opts,
    );

    expect(guard.spendBreakdown.setupUsd).toBe(0);
    expect(guard.costCapped).toBe(false);
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toContain('upstream 500');
  });

  it('skips the visibility layer when a product has no descriptor and no category', async () => {
    const noCategory: BrandProfile = { ...PROFILE, category: undefined };
    const judge: JudgeClient = {
      model: 'gpt-5.4-mini',
      async complete() {
        throw new Error('no judge today');
      },
    };

    const result = await generateProductQueries(
      noCategory,
      [{ name: 'Presto X' }],
      { judge, guard: new CostGuard() },
      opts,
    );

    expect(result.prompts.filter((p) => p.layer === 'visibility')).toEqual([]);
    expect(result.prompts.filter((p) => p.layer === 'reputation')).toHaveLength(
      1,
    );
    expect(result.notes.join(' ')).toContain('Presto X');
    expect(result.notes.join(' ')).toContain('descriptor');
  });
});
