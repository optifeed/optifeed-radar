import { describe, expect, it } from 'vitest';
import {
  CostGuard,
  ESTIMATE_ASSUMPTIONS,
  MODEL_PRICING,
  assumedOutputTokens,
  costOfCall,
} from '../costs.js';
import type { EngineAnswer, EngineId } from '../types.js';
import type { EngineAdapter } from './adapter.js';
import { UNMEASURED_CALL_MARGIN, askAll } from './runner.js';

function fakeAdapter(
  id: EngineId,
  opts: {
    available?: boolean;
    costUsd?: number;
    failOn?: (prompt: string) => boolean;
    /** Override so the adapter can use a model that IS in MODEL_PRICING. */
    model?: string;
    supportsGrounded?: boolean;
  } = {},
): EngineAdapter {
  const model = opts.model ?? `${id}-model`;
  return {
    id,
    kind: 'parametric',
    model,
    supportsGrounded: opts.supportsGrounded,
    available: () => opts.available ?? true,
    async ask(prompt): Promise<EngineAnswer> {
      if (opts.failOn?.(prompt)) throw new Error(`${id} boom`);
      return {
        engine: id,
        kind: 'parametric',
        prompt,
        text: `${id}:${prompt}`,
        model,
        costUsd: opts.costUsd ?? 0.01,
        ts: 't',
      };
    },
  };
}

describe('askAll cost-cap control flow', () => {
  // `costCapped` latches: it records the honest fact that the cap refused
  // something. But askAll short-circuited on that flag before even asking, so
  // ONE transient reservation spike - reservations are projections, and they
  // settle back down - abandoned every remaining prompt across every engine,
  // producing a needlessly thin sample and a degraded score while the reported
  // spend sat far under the cap. The flag is history; the BUDGET governs new
  // spend, so each prompt must be offered to the guard on its own merits.
  it('keeps asking prompts the budget can still afford after the cap flag latched', async () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    // Trip the flag with one refused oversized reservation. Nothing is spent
    // and nothing is held, so the full $1 budget is still available.
    expect(guard.authorize(5)).toBe(false);
    expect(guard.costCapped).toBe(true);

    const result = await askAll(
      ['p1', 'p2'],
      [fakeAdapter('openai', { costUsd: 0.001, model: 'gpt-4o-mini' })],
      { guard },
    );

    expect(result.answers).toHaveLength(2);
  });

  // The flag must still stop a run whose budget is genuinely exhausted.
  it('stops asking once the budget really is spent', async () => {
    const guard = new CostGuard({ maxCostUsd: 0.001 });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4'],
      [fakeAdapter('openai', { costUsd: 0.0005, model: 'gpt-5.4' })],
      { guard },
    );
    expect(result.answers.length).toBeLessThan(4);
    expect(guard.costCapped).toBe(true);
  });
});

describe('askAll cost estimation safety', () => {
  // estimateCall returned 0 for a model absent from MODEL_PRICING, so every
  // authorize(0) succeeded and --max-cost was silently unenforceable for that
  // engine - unbounded real spend against a cap the user explicitly set.
  // An unknown price means "assume expensive", never "assume free": the same
  // never-under-estimate guarantee estimateCallUsd already documents.
  it('does not treat an unpriced model as free when a cap is set', async () => {
    const guard = new CostGuard({ maxCostUsd: 0.001 });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4'],
      // A model id that is deliberately NOT in MODEL_PRICING.
      [fakeAdapter('openai', { model: 'some-unreleased-model-id' })],
      { guard },
    );
    // A conservative unknown-model price exceeds this cap outright, so the
    // very first authorization must refuse and NOTHING is spent. Asserting 0
    // rather than "fewer than 4" is deliberate: with a 0 reservation the run
    // still bills for one call before settle notices the overshoot, so a
    // looser assertion would pass against the unfixed code.
    expect(result.answers).toHaveLength(0);
    expect(guard.spentUsd).toBe(0);
    expect(guard.costCapped).toBe(true);
  });

  // Until an engine has answered once, its cost is a GUESS, and a guess that
  // lands low is spent money the cap cannot claw back. Measured live: with
  // corrected token assumptions, real calls still came in up to ~1.3x their
  // reservation. Unmeasured calls therefore reserve with a margin; once the
  // engine has reported a real cost, the observed figure takes over and the
  // margin no longer applies.
  it('reserves a margin for a call whose cost has never been measured', async () => {
    const pricing = MODEL_PRICING.models['gpt-4o-mini']!;
    const bare = costOfCall(
      pricing,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      assumedOutputTokens(pricing),
    );
    // A budget that covers the bare estimate but NOT the margined one. The
    // first call must be refused, which is only possible if the margin is
    // actually applied to an unmeasured engine.
    const guard = new CostGuard({ maxCostUsd: bare * 1.05 });
    const result = await askAll(
      ['only'],
      [fakeAdapter('openai', { costUsd: 0.0001, model: 'gpt-4o-mini' })],
      { guard },
    );

    expect(result.answers).toHaveLength(0);
    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBe(0);
  });

  // The margin must NOT persist once the engine's real cost is known, or a
  // long run would keep over-reserving and refuse calls it can afford.
  it('drops the margin once a real cost has been observed', async () => {
    const pricing = MODEL_PRICING.models['gpt-4o-mini']!;
    const bare = costOfCall(
      pricing,
      ESTIMATE_ASSUMPTIONS.avgInputTokens,
      assumedOutputTokens(pricing),
    );
    // Enough for the margined first reservation PLUS the three remaining
    // prompts reserving concurrently at the (unmargined) observed rate.
    const guard = new CostGuard({
      maxCostUsd: bare * (UNMEASURED_CALL_MARGIN + 3),
    });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4'],
      // Real cost is a tiny fraction of the estimate, so after the first call
      // the observed figure should let every remaining prompt through.
      [fakeAdapter('openai', { costUsd: 0.000001, model: 'gpt-4o-mini' })],
      { guard },
    );

    expect(result.answers).toHaveLength(4);
  });

  // The probe exists to replace the static estimate with a real measurement
  // before fanning out. It only learned from a SUCCESSFUL call, so a single
  // transient failure on the first prompt sent the whole concurrent wave out
  // against the very estimate the probe was added to replace.
  it('keeps probing sequentially until it gets a real cost observation', async () => {
    const guard = new CostGuard({ maxCostUsd: 1 });
    let inFlight = 0;
    let sawSuccess = false;
    // Concurrency reached BEFORE any call reported a cost. Fan-out after the
    // first observation is expected and not what this test constrains.
    let maxInFlightWhileBlind = 0;
    const adapter: EngineAdapter = {
      id: 'gemini',
      kind: 'parametric',
      model: 'gemini-flash-latest',
      available: () => true,
      async ask(prompt): Promise<EngineAnswer> {
        inFlight += 1;
        if (!sawSuccess) {
          maxInFlightWhileBlind = Math.max(maxInFlightWhileBlind, inFlight);
        }
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        // The first two probes fail; only the third yields an observation.
        if (prompt === 'p1' || prompt === 'p2') throw new Error('429');
        sawSuccess = true;
        return {
          engine: 'gemini',
          kind: 'parametric',
          prompt,
          text: 'ok',
          model: 'gemini-flash-latest',
          costUsd: 0.01,
          ts: 't',
        };
      },
    };

    await askAll(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], [adapter], { guard });

    // Nothing may fan out until one call has actually reported a cost.
    expect(maxInFlightWhileBlind).toBe(1);
  });
});

describe('askAll grounding fee reservation', () => {
  // A grounded Gemini call owes $14/1,000 per SEARCH on top of tokens - on the
  // real captured call the fee ($0.042) exceeded the whole token cost
  // ($0.034). Reserving tokens only would admit calls the budget cannot pay
  // for, which is precisely how --max-cost was breached by 74% on 2026-07-20.
  it('reserves the search fee, so a tight cap admits fewer grounded calls', async () => {
    const prompts = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const adapter = (): EngineAdapter =>
      fakeAdapter('gemini', {
        model: 'gemini-flash-latest',
        supportsGrounded: true,
        costUsd: 0.0001, // tiny actual, so only the RESERVATION differs
      });

    const parametricGuard = new CostGuard({ maxCostUsd: 0.2 });
    const parametric = await askAll(prompts, [adapter()], {
      guard: parametricGuard,
    });

    const groundedGuard = new CostGuard({ maxCostUsd: 0.2 });
    const grounded = await askAll(prompts, [adapter()], {
      guard: groundedGuard,
      mode: 'grounded',
    });

    // Same cap, same prompts: grounded reserves ~5 searches x $0.014 extra per
    // call, so fewer calls fit. If the fee is not reserved these are equal.
    expect(grounded.answers.length).toBeLessThan(parametric.answers.length);
    expect(groundedGuard.costCapped).toBe(true);
  });

  // Rule #6: under --grounded, an engine that cannot search is honestly tagged
  // parametric. Reserving a search fee for it would shrink the budget for
  // searches that never happen.
  it('reserves no search fee for an engine that cannot ground', async () => {
    const prompts = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const adapter = (): EngineAdapter =>
      fakeAdapter('anthropic', {
        model: 'claude-sonnet-5',
        supportsGrounded: false,
        costUsd: 0.0001,
      });

    const parametric = await askAll(prompts, [adapter()], {
      guard: new CostGuard({ maxCostUsd: 0.05 }),
    });
    const grounded = await askAll(prompts, [adapter()], {
      guard: new CostGuard({ maxCostUsd: 0.05 }),
      mode: 'grounded',
    });

    expect(grounded.answers.length).toBe(parametric.answers.length);
  });
});

describe('askAll', () => {
  it('builds the full answer matrix across adapters and prompts', async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [fakeAdapter('openai'), fakeAdapter('anthropic')],
    );
    expect(result.answers).toHaveLength(4);
    expect(result.skippedEngines).toEqual([]);
  });

  it('skips unavailable adapters with a reason', async () => {
    const result = await askAll(
      ['p1'],
      [fakeAdapter('openai'), fakeAdapter('gemini', { available: false })],
    );
    expect(result.answers.map((a) => a.engine)).toEqual(['openai']);
    expect(result.skippedEngines).toContainEqual({
      engine: 'gemini',
      reason: expect.stringContaining('key'),
    });
  });

  it("a single adapter's total failure never kills the run", async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [
        fakeAdapter('openai'),
        fakeAdapter('perplexity', { failOn: () => true }),
      ],
    );
    expect(result.answers.map((a) => a.engine).sort()).toEqual([
      'openai',
      'openai',
    ]);
    expect(result.skippedEngines[0]?.engine).toBe('perplexity');
  });

  it('keeps partial successes when only some prompts fail', async () => {
    const result = await askAll(
      ['good', 'bad'],
      [fakeAdapter('openai', { failOn: (p) => p === 'bad' })],
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.prompt).toBe('good');
    expect(result.skippedEngines).toEqual([]);
  });

  it('ticks onAnswered exactly once per individual call (ok and error paths)', async () => {
    let ticks = 0;
    await askAll(
      ['good', 'bad'],
      [
        fakeAdapter('openai'),
        fakeAdapter('perplexity', { failOn: (p) => p === 'bad' }),
      ],
      { onAnswered: () => (ticks += 1) },
    );
    // 2 prompts x 2 adapters, each settles once (one of them errors).
    expect(ticks).toBe(4);
  });

  it('ticks onAnswered once per call when the cost cap stops asking', async () => {
    const guard = new CostGuard({ maxCostUsd: 0 }); // caps immediately
    let ticks = 0;
    await askAll(['p1', 'p2'], [fakeAdapter('openai', { costUsd: 0.02 })], {
      guard,
      onAnswered: () => (ticks += 1),
    });
    // Both prompts settle (as capped) and each ticks exactly once - no double count.
    expect(ticks).toBe(2);
  });

  it('records per-call cost into the CostGuard', async () => {
    const guard = new CostGuard();
    await askAll(['p1', 'p2'], [fakeAdapter('openai', { costUsd: 0.02 })], {
      guard,
    });
    expect(guard.spentUsd).toBeCloseTo(0.04, 10);
  });

  // Found live 2026-07-20: a free-tier Gemini key rate-limited 7 of 8 calls.
  // The engine answered ONCE, was scored on that single sample, sat in the
  // report next to engines with 8, and the run carried NO honesty flag - every
  // derived artifact (diff, --fail-under, HTML) read it as complete. The errors
  // were computed and then dropped on the floor (lesson #7, fetch-and-discard).
  // Partial failure is a distinct signal from total failure, so it gets its own
  // flag rather than being folded into `skippedEngines` (the engine was NOT
  // skipped - it produced real, scoreable answers).
  it('reports an engine that answered only some prompts as partial', async () => {
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4'],
      [fakeAdapter('gemini', { failOn: (p) => p !== 'p1' })],
    );

    expect(result.answers).toHaveLength(1);
    // Not skipped - it answered.
    expect(result.skippedEngines).toEqual([]);
    expect(result.partialEngines).toHaveLength(1);
    expect(result.partialEngines[0]).toMatchObject({
      engine: 'gemini',
      attempted: 4,
      answered: 1,
    });
    expect(result.partialEngines[0]!.reason).toContain('boom');
  });

  // The boundary between the two signals must stay exact: a TOTAL failure is
  // skipped (already correct, verified live against a quota-exhausted Gemini),
  // and must NOT also be double-reported as partial.
  it('keeps a totally-failed engine skipped, not partial', async () => {
    const result = await askAll(
      ['p1', 'p2'],
      [fakeAdapter('gemini', { failOn: () => true })],
    );
    expect(result.skippedEngines).toHaveLength(1);
    expect(result.partialEngines).toEqual([]);
  });

  it('reports no partial engines when every call succeeds', async () => {
    const result = await askAll(['p1', 'p2'], [fakeAdapter('openai')]);
    expect(result.partialEngines).toEqual([]);
  });

  // Adapters fan out concurrently while `costCapped` is a single global flag,
  // so one engine can answer every prompt while another is truncated mid-way.
  // Gating the partial signal on errors alone missed that entirely: the only
  // trace was the run-level "cost cap reached" note, which names no engine and
  // carries no counts - defeating the very reason PartialEngine holds numbers.
  it('reports a cost-capped truncation as partial, naming the cap', async () => {
    // Budget allows ~2 calls at $0.02; the rest are refused by the guard.
    // The model must be a PRICED one: an unpriced id now reserves the
    // conservative unknown-model figure (it used to reserve $0, which is the
    // bug that made --max-cost unenforceable), and that would refuse every
    // call here rather than exercising the truncation this test is about.
    const guard = new CostGuard({ maxCostUsd: 0.05 });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      [fakeAdapter('openai', { costUsd: 0.02, model: 'gpt-4o-mini' })],
      { guard, concurrency: 1 },
    );

    expect(guard.costCapped).toBe(true);
    expect(result.answers.length).toBeGreaterThan(0);
    expect(result.answers.length).toBeLessThan(5);
    expect(result.skippedEngines).toEqual([]);
    expect(result.partialEngines).toHaveLength(1);
    const p = result.partialEngines[0]!;
    expect(p.engine).toBe('openai');
    expect(p.answered).toBe(result.answers.length);
    expect(p.attempted).toBe(5);
    expect(p.reason.toLowerCase()).toContain('cost cap');
  });

  // The static per-call estimate assumes 500 output tokens. Gemini averaged
  // 2584 live (thinking tokens are billed as output), so each call really cost
  // 4.9x what was authorized. Reserving fixes the concurrency race, but a
  // reservation that is itself 5x too small still lets a whole CONCURRENT WAVE
  // through against headroom that cannot pay for it. Once an engine has
  // completed a call, later calls must be authorized against what that engine
  // actually costs (hard rule #5).
  //
  // Shape: cap $0.30, 4 concurrent, each call really $0.05 but statically
  // estimated at ~$0.0057. Wave 1 spends $0.20 (unavoidable - nothing observed
  // yet). Wave 2 then has $0.10 of headroom: reserving the stale $0.0057 lets
  // all 4 through for another $0.20 (total $0.40, cap blown by a third);
  // reserving the observed $0.05 admits only 2 and stops at the cap.
  it('authorizes later waves against an engine observed cost, not the assumption', async () => {
    const guard = new CostGuard({ maxCostUsd: 0.3 });
    await askAll(
      [
        'p1',
        'p2',
        'p3',
        'p4',
        'p5',
        'p6',
        'p7',
        'p8',
        'p9',
        'p10',
        'p11',
        'p12',
      ],
      [fakeAdapter('perplexity', { costUsd: 0.05, model: 'sonar' })],
      { guard }, // default concurrency (4)
    );

    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBeLessThanOrEqual(0.3);
  });

  // Residual after reserving + adapting: the FIRST wave has no observation to
  // adapt to, so `concurrency` calls all reserve the stale estimate at once and
  // a thinking-heavy engine still overshoots (live: 74% -> 28%). Probing with a
  // single call before fanning out buys a real cost measurement for the price
  // of one round trip, so every later authorization is accurate.
  //
  // Shape: cap $0.10, 4 concurrent, each call really $0.05 vs ~$0.0057
  // estimated. Fanning out immediately admits 4 calls ($0.20, double the cap);
  // probing first spends $0.05, learns the real cost, and admits exactly one
  // more.
  it('probes with one call before fanning out, so the first wave cannot blow the cap', async () => {
    const guard = new CostGuard({ maxCostUsd: 0.1 });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      [fakeAdapter('perplexity', { costUsd: 0.05, model: 'sonar' })],
      { guard }, // default concurrency (4)
    );

    expect(guard.spentUsd).toBeLessThanOrEqual(0.1);
    expect(result.answers).toHaveLength(2);
    expect(guard.costCapped).toBe(true);
  });

  // The probe must not change results when no cap is in play - it is a spend
  // control, not a behaviour change.
  it('still answers every prompt when there is no cost guard', async () => {
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      [fakeAdapter('openai')],
    );
    expect(result.answers).toHaveLength(5);
    expect(result.answers.map((a) => a.prompt)).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
    ]);
  });

  // Mixed causes must not be misattributed. Blaming the rate limiter for
  // prompts the COST CAP refused to send is a false statement about why the
  // sample is thin, which is what the reason string exists to explain.
  it('names both causes when some calls errored and others were capped', async () => {
    const guard = new CostGuard({ maxCostUsd: 0.05 });
    const result = await askAll(
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      [
        // Priced model on purpose: an unpriced one now reserves the
        // conservative unknown-model figure, which would refuse every call so
        // the ERROR cause could never fire and this test would pass on a
        // cap-only reason.
        fakeAdapter('gemini', {
          costUsd: 0.02,
          model: 'gpt-4o-mini',
          failOn: (prompt) => prompt === 'p1',
        }),
      ],
      { guard, concurrency: 1 },
    );

    expect(result.partialEngines).toHaveLength(1);
    const reason = result.partialEngines[0]!.reason.toLowerCase();
    expect(reason).toContain('boom'); // the real error
    expect(reason).toContain('cost cap'); // and the cap, not blamed on the error
  });
});
