import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { JudgeClient } from '../types.js';
import { discoverCompetitors, parseCompetitors } from './competitors.js';

/** A judge that records the prompt it saw and returns a canned answer. */
function recordingJudge(
  text: string,
  costUsd = 0.001,
  model = 'gpt-4o-mini',
): JudgeClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model,
    async complete(prompt) {
      prompts.push(prompt);
      return { text, costUsd, model };
    },
  };
}

describe('discoverCompetitors', () => {
  it('parses a JSON array of names and bills the setup budget', async () => {
    const judge = recordingJudge('["Estes", "Quest Aerospace"]', 0.002);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme Rockets', category: 'Model rockets' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Estes', 'Quest Aerospace']);
    expect(guard.spentUsd).toBeCloseTo(0.002, 10);
    expect(judge.prompts[0]).toContain('Acme Rockets');
  });

  // Live 2026-07-17 (www.do-re.com.tr, a Turkish music retailer): the profile
  // correctly extracted locale "tr", but the competitor prompt never received
  // it, so the judge returned 8 US chains (Guitar Center, Sam Ash, Sweetwater
  // ...). NONE of them appeared even once across 20 Turkish answers, so the
  // whole share-of-voice table read 0%. Lesson #7: do not extract a signal and
  // then discard it at the one call site that needs it.
  it('passes the locale to the judge so competitors match the brand market', async () => {
    const judge = recordingJudge('["Zuhal Müzik", "Mydukkan"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'doremusic', category: 'Musical instruments', locale: 'tr' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Zuhal Müzik', 'Mydukkan']);
    // Assert a DISTINCTIVE marker, not a bare "tr" (which matches "insTRuments"
    // in the category) or "market" (the base prompt already says "map a market").
    // A loose assertion here passes against the buggy prompt - false green.
    expect(judge.prompts[0]).toContain('Primary market (locale): tr');
  });

  it('omits the locale line entirely when the profile has no locale', async () => {
    const judge = recordingJudge('["Estes"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await discoverCompetitors({ brand: 'Acme' }, { judge, guard });

    expect(judge.prompts[0]).not.toMatch(/Primary market/i);
  });

  it('parses a JSON array even when a later bracket appears in prose', () => {
    expect(parseCompetitors('["Estes","Quest"] (see ref [1])')).toEqual([
      'Estes',
      'Quest',
    ]);
  });

  it('parses a numbered/bulleted list when the model does not return JSON', async () => {
    const judge = recordingJudge('1. Estes\n2. Quest\n- Apogee Components\n');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Estes', 'Quest', 'Apogee Components']);
  });

  it('skips the call and never spends when it would exceed the setup cap', async () => {
    const judge = recordingJudge('["Estes"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.0000001 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual([]);
    expect(result.skipped).toBeDefined();
    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBe(0); // the guarded call never ran
    expect(judge.prompts).toEqual([]);
  });

  it('degrades to no competitors (never throws) when the judge errors', async () => {
    const judge: JudgeClient = {
      model: 'gpt-4o-mini',
      complete() {
        return Promise.reject(new Error('502 upstream'));
      },
    };
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual([]);
    expect(result.skipped).toContain('502');
    expect(guard.spentUsd).toBe(0);
  });
});
