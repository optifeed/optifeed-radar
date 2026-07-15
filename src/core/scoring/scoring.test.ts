import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type EngineId,
  type EngineKind,
  type JudgeClient,
} from '../types.js';
import { scoreAnswers } from './scoring.js';

const AT = '2026-07-15T00:00:00.000Z';

const profile: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme',
  aliases: ['Acme Rockets'],
  competitors: ['Estes', 'Quest'],
};

function ans(
  engine: EngineId,
  kind: EngineKind,
  text: string,
  citations?: string[],
): EngineAnswer {
  return {
    engine,
    kind,
    prompt: 'best model rocket kits?',
    text,
    model: 'm',
    costUsd: 0,
    ts: AT,
    ...(citations ? { citations } : {}),
  };
}

/** Like {@link ans} but with an explicit prompt (for intent partitioning). */
function ansP(
  engine: EngineId,
  kind: EngineKind,
  prompt: string,
  text: string,
): EngineAnswer {
  return { engine, kind, prompt, text, model: 'm', costUsd: 0, ts: AT };
}

describe('scoreAnswers (orchestration)', () => {
  it('excludes branded prompts from the score and reports them as reputation', async () => {
    const answers = [
      // Discovery: unbranded, mentions the brand.
      ansP(
        'openai',
        'parametric',
        'best rockets?',
        'I recommend Acme, then Estes.',
      ),
      // Branded ("trust"): named the brand, positive sentiment.
      ansP(
        'openai',
        'parametric',
        'Is Acme reliable?',
        'Yes, Acme is very reliable and highly trusted.',
      ),
    ];

    const report = await scoreAnswers(
      answers,
      profile,
      {},
      { generatedAt: AT, brandedPrompts: ['Is Acme reliable?'] },
    );

    // Score and per-engine aggregation see ONLY the discovery answer.
    expect(report.engines).toHaveLength(1);
    expect(report.engines[0]!.answers).toBe(1);
    expect(report.mentions).toHaveLength(1);
    expect(report.mentions[0]!.prompt).toBe('best rockets?');
    expect(report.sampling.answers).toBe(1);

    // The branded answer surfaces separately as reputation (sentiment).
    expect(report.reputation).toEqual({
      prompts: 1,
      answers: 1,
      positive: 1,
      neutral: 0,
      negative: 0,
    });
  });

  it('reports no reputation block when no prompts are branded', async () => {
    const report = await scoreAnswers(
      [ans('openai', 'parametric', 'Acme is great.')],
      profile,
      {},
      { generatedAt: AT },
    );
    expect(report.reputation).toBeUndefined();
  });

  it('produces a deterministic report across engines with no judge needed', async () => {
    const answers = [
      ans('openai', 'parametric', 'I recommend Acme, then Estes.'),
      ans('openai', 'parametric', 'Estes is best; Quest is fine.'),
      ans('perplexity', 'grounded', 'Acme is the top pick and very reliable.', [
        'https://acme.example/kits',
        'https://reviews.com/x',
      ]),
    ];

    const report = await scoreAnswers(
      answers,
      profile,
      {},
      { generatedAt: AT },
    );

    expect(report.schema_version).toBe(SCHEMA_VERSION);
    expect(report.domain).toBe('acme.example');
    expect(report.sampling).toEqual({
      answers: 3,
      judged: 0,
      judgeRateCap: 0.3,
    });

    // Two engines scored, composite is a weighted mean of them.
    expect(report.engines.map((e) => e.engine).sort()).toEqual([
      'openai',
      'perplexity',
    ]);
    const openai = report.engines.find((e) => e.engine === 'openai')!;
    expect(openai.mentions).toBe(1);
    expect(openai.answers).toBe(2);

    // Perplexity: 1/1 mention at position 1, positive → high score.
    const pplx = report.engines.find((e) => e.engine === 'perplexity')!;
    expect(pplx.kind).toBe('grounded');
    expect(pplx.mentions).toBe(1);
    expect(pplx.score).toBeGreaterThan(openai.score);

    expect(report.score).toBe(
      Math.round((openai.score * 1.0 + pplx.score * 1.5) / (1.0 + 1.5)),
    );

    // SoV over brand + competitors; sources from the grounded citation.
    expect(report.shareOfVoice.find((r) => r.isBrand)?.name).toBe('Acme');
    expect(report.sources).toEqual([
      { domain: 'acme.example', count: 1 },
      { domain: 'reviews.com', count: 1 },
    ]);
  });

  it('runs the judge pass to overturn a generic-word false positive', async () => {
    const orangeProfile: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'orange.example',
      brand: 'Orange',
      aliases: [],
      competitors: [],
    };
    const answers = [ans('openai', 'parametric', 'I love fresh orange juice.')];
    const judge: JudgeClient = {
      model: 'gpt-4o-mini',
      async complete() {
        return { text: '{"mentioned": false}', costUsd: 0.001, model: 'm' };
      },
    };

    const report = await scoreAnswers(
      answers,
      orangeProfile,
      { judge, guard: new CostGuard() },
      { generatedAt: AT, judgeRateCap: 1 },
    );

    expect(report.sampling.judged).toBe(1);
    expect(report.mentions[0]!.mentioned).toBe(false);
    expect(report.engines[0]!.score).toBe(0); // false positive removed
  });

  it('tags the report with the scoring schema version, not the profile version', async () => {
    const oldProfile: BrandProfile = { ...profile, schema_version: '0.0' };
    const report = await scoreAnswers(
      [ans('openai', 'parametric', 'Acme is fine.')],
      oldProfile,
      {},
      { generatedAt: AT },
    );
    expect(report.schema_version).toBe(SCHEMA_VERSION);
  });

  it('skips the judge pass entirely when no judge is provided', async () => {
    const answers = [ans('openai', 'parametric', 'I love fresh orange juice.')];
    const orangeProfile: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'orange.example',
      brand: 'Orange',
      aliases: [],
      competitors: [],
    };

    const report = await scoreAnswers(
      answers,
      orangeProfile,
      {},
      {
        generatedAt: AT,
      },
    );

    expect(report.sampling.judged).toBe(0);
    // Pass 1 kept the (ambiguous) match since no judge ran.
    expect(report.mentions[0]!.mentioned).toBe(true);
    expect(report.mentions[0]!.ambiguous).toBe(true);
  });
});
