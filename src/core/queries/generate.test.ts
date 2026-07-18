import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
  type QueryIntent,
} from '../types.js';
import {
  activeIntents,
  buildQueryPack,
  excludeCompetitors,
  generateQueries,
  parseIntentQueries,
} from './generate.js';

const AT_ISO = '2026-07-15T00:00:00.000Z';

/** A judge that records prompts (and token budgets) it saw and returns a canned answer. */
function recordingJudge(
  text: string,
  costUsd = 0.001,
): JudgeClient & { prompts: string[]; maxTokens: (number | undefined)[] } {
  const prompts: string[] = [];
  const maxTokens: (number | undefined)[] = [];
  return {
    prompts,
    maxTokens,
    model: 'gpt-4o-mini',
    async complete(prompt, opts) {
      prompts.push(prompt);
      maxTokens.push(opts?.maxTokens);
      return { text, costUsd, model: 'gpt-4o-mini' };
    },
  };
}

function profile(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: SCHEMA_VERSION,
    domain: 'acme.example',
    brand: 'Acme Rockets',
    aliases: [],
    competitors: [],
    ...overrides,
  };
}

describe('activeIntents', () => {
  it('skips the local intent when the profile has no geo', () => {
    expect(activeIntents(profile())).toEqual([
      'best-of',
      'comparison',
      'problem',
      'trust',
    ]);
  });

  it('includes local when the profile carries a geo', () => {
    expect(activeIntents(profile({ geo: 'Portland, OR' }))).toEqual([
      'best-of',
      'comparison',
      'problem',
      'trust',
      'local',
    ]);
  });
});

describe('excludeCompetitors', () => {
  it('drops prompts naming a competitor (word-boundary, case-insensitive)', () => {
    const prompts = [
      'What are the best model rocket kits?',
      'Is ESTES better for beginners?', // names a competitor
      'Which brand has the safest engines?',
    ];
    expect(excludeCompetitors(prompts, ['Estes', 'Quest'])).toEqual([
      'What are the best model rocket kits?',
      'Which brand has the safest engines?',
    ]);
  });

  it('does not treat a competitor as a substring of another word', () => {
    // "Quest" must not knock out "question".
    expect(
      excludeCompetitors(['What is the question buyers ask?'], ['Quest']),
    ).toEqual(['What is the question buyers ask?']);
  });

  it('strips competitors with non-word edge characters (C++, .NET)', () => {
    expect(
      excludeCompetitors(
        ['Is C++ the best choice?', 'What about memory safety?'],
        ['C++'],
      ),
    ).toEqual(['What about memory safety?']);
    expect(excludeCompetitors(['Should I use .NET here?'], ['.NET'])).toEqual(
      [],
    );
  });

  it('strips non-Latin competitor names', () => {
    expect(
      excludeCompetitors(
        ['楽天と比べてどうですか?', '通常の質問です'],
        ['楽天'],
      ),
    ).toEqual(['通常の質問です']);
  });
});

describe('parseIntentQueries', () => {
  it('parses a JSON object keyed by intent, ignoring unknown intents', () => {
    const text = JSON.stringify({
      'best-of': ['What are the best rocket kits?'],
      problem: ['How do I fix a misfiring engine?'],
      nonsense: ['ignored'],
    });
    const byIntent = parseIntentQueries(text, [
      'best-of',
      'comparison',
      'problem',
      'trust',
    ]);
    expect(byIntent['best-of']).toEqual(['What are the best rocket kits?']);
    expect(byIntent.problem).toEqual(['How do I fix a misfiring engine?']);
    expect(byIntent.comparison).toEqual([]);
    expect('nonsense' in byIntent).toBe(false);
  });

  it('tolerates a fenced JSON block', () => {
    const text = '```json\n{"trust": ["Is this brand reputable?"]}\n```';
    const byIntent = parseIntentQueries(text, ['trust']);
    expect(byIntent.trust).toEqual(['Is this brand reputable?']);
  });

  it('extracts the object even when prose with braces follows the JSON', () => {
    const text =
      'Sure!\n```json\n{"best-of":["a","b"]}\n```\nLet me know if you need {more}.';
    expect(parseIntentQueries(text, ['best-of'])['best-of']).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('buildQueryPack', () => {
  const AT = '2026-07-15T00:00:00.000Z';
  const intents: QueryIntent[] = ['best-of', 'comparison', 'problem'];

  // best-of is the most rewrite-stable prompt form across engines (Profound
  // fanout study), so it gets the largest share of a capped pack. With ample
  // supply and target 8 over 4 intents, equal round-robin would give 2 each
  // (best-of tied, not highest); the best-of weight (2x) must make it STRICTLY
  // the most-represented intent.
  it('weights best-of highest when capping the pack', () => {
    const weighted: QueryIntent[] = [
      'best-of',
      'comparison',
      'problem',
      'trust',
    ];
    const pack = buildQueryPack({
      domain: 'acme.example',
      byIntent: {
        'best-of': ['A1', 'A2', 'A3'],
        comparison: ['B1', 'B2', 'B3'],
        problem: ['C1', 'C2', 'C3'],
        trust: ['D1', 'D2', 'D3'],
        local: [],
      },
      intents: weighted,
      competitors: [],
      target: 8,
      generatedAt: AT,
    });

    const counts = pack.queries.reduce<Record<string, number>>((m, q) => {
      m[q.intent] = (m[q.intent] ?? 0) + 1;
      return m;
    }, {});
    expect(pack.queries).toHaveLength(8);
    for (const intent of weighted) {
      if (intent === 'best-of') continue;
      expect(counts[intent] ?? 0).toBeLessThan(counts['best-of']!);
    }
    expect(pack.queries.map((q) => q.id)).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
      'q6',
      'q7',
      'q8',
    ]);
    expect(pack.schema_version).toBe(SCHEMA_VERSION);
    expect(pack.generatedAt).toBe(AT);
  });

  // Balance survives truncation: best-of is over-represented but SPREAD through
  // the pack, not clustered at the front. askAll asks prompts in pack order and
  // a mid-run cost cap stops the rest, so a front-loaded best-of block would make
  // a capped run's headline score all-best-of. The leading cycle must sample
  // every intent.
  it('spreads intents through the pack so a truncated run stays balanced', () => {
    const weighted: QueryIntent[] = [
      'best-of',
      'comparison',
      'problem',
      'trust',
    ];
    const pack = buildQueryPack({
      domain: 'acme.example',
      byIntent: {
        'best-of': ['A1', 'A2', 'A3'],
        comparison: ['B1', 'B2', 'B3'],
        problem: ['C1', 'C2', 'C3'],
        trust: ['D1', 'D2', 'D3'],
        local: [],
      },
      intents: weighted,
      competitors: [],
      target: 8,
      generatedAt: AT,
    });

    // The first four prompts (one full cycle) cover all four intents - a capped
    // run that only got this far still measured every intent.
    const firstCycle = new Set(pack.queries.slice(0, 4).map((q) => q.intent));
    expect(firstCycle.size).toBe(4);
  });

  it('excludes competitor-naming prompts and de-dupes before capping', () => {
    const pack = buildQueryPack({
      domain: 'acme.example',
      byIntent: {
        'best-of': ['Best kits?', 'Estes rocks', 'Best kits?'],
        comparison: [],
        problem: [],
        trust: [],
        local: [],
      },
      intents: ['best-of'],
      competitors: ['Estes'],
      target: 20,
      generatedAt: AT,
    });

    expect(pack.queries.map((q) => q.prompt)).toEqual(['Best kits?']);
  });

  it('returns only what is available when fewer than the target', () => {
    const pack = buildQueryPack({
      domain: 'acme.example',
      byIntent: {
        'best-of': ['A1'],
        comparison: ['B1'],
        problem: [],
        trust: [],
        local: [],
      },
      intents,
      competitors: [],
      target: 20,
      generatedAt: AT,
    });

    expect(pack.queries).toHaveLength(2);
  });
});

describe('generateQueries', () => {
  function profile(overrides: Partial<BrandProfile> = {}): BrandProfile {
    return {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme Rockets',
      aliases: [],
      category: 'model rockets',
      competitors: ['Estes'],
      ...overrides,
    };
  }

  const goodAnswer = JSON.stringify({
    'best-of': ['Best model rocket kits for beginners?'],
    comparison: ['How do rocket kit brands compare?'],
    problem: ['Why does my rocket engine misfire?'],
    trust: ['Is Acme Rockets a reputable brand?'],
  });

  it('generates a pack from one guarded judge call, competitor input withheld', async () => {
    const judge = recordingJudge(goodAnswer, 0.002);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const { pack, skipped } = await generateQueries(
      profile(),
      { judge, guard },
      { count: 4, generatedAt: AT_ISO },
    );

    expect(skipped).toBeUndefined();
    expect(pack.queries).toHaveLength(4);
    expect(pack.queries.map((q) => q.intent)).toEqual([
      'best-of',
      'comparison',
      'problem',
      'trust',
    ]);
    expect(pack.generatedAt).toBe(AT_ISO);
    expect(guard.spentUsd).toBeCloseTo(0.002, 10);
    // Prompt carries the category but NOT the competitor (used only at scoring).
    expect(judge.prompts[0]).toContain('model rockets');
    expect(judge.prompts[0]).not.toContain('Estes');
  });

  it('instructs the model to write self-contained questions (no dangling back-references)', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await generateQueries(profile(), { judge, guard }, { generatedAt: AT_ISO });

    const gen = judge.prompts[0]!;
    // The core fix: each question must stand alone (it is sent to the engine
    // with no prior turn), so demonstratives like "this brand" / "these
    // products" that point at nothing are forbidden.
    expect(gen.toLowerCase()).toContain('self-contained');
    expect(gen.toLowerCase()).toContain('back-reference');
    // Trust questions name the brand explicitly, not "this brand".
    expect(gen).toContain('name the brand');
  });

  // Retrieval-informed rules (Profound fanout study): the generation prompt must
  // (1) ask for more best-of than any other intent (rewrite-stable), (2) prefer
  // concrete/specific over broad thematic questions, and (3) pair a
  // constraint-carrying question with an unconstrained variant (engines drop
  // constraints) - the pair counted within the totals, never added on top.
  it('asks the model for more best-of questions than any other intent', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await generateQueries(
      profile(),
      { judge, guard },
      { count: 20, generatedAt: AT_ISO },
    );

    const gen = judge.prompts[0]!;
    // Each intent line carries its own count, e.g. `"best-of" (write N)`.
    const countFor = (intent: string): number => {
      const line = gen.split('\n').find((l) => l.includes(`"${intent}"`)) ?? '';
      const num = parseInt(line.split('write ')[1] ?? '', 10);
      return Number.isNaN(num) ? 0 : num;
    };
    const bestOf = countFor('best-of');
    expect(bestOf).toBeGreaterThan(0);
    for (const intent of ['comparison', 'problem', 'trust']) {
      expect(countFor(intent)).toBeLessThan(bestOf);
    }
  });

  it('instructs the model to prefer concrete questions and pair constrained with unconstrained variants', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await generateQueries(profile(), { judge, guard }, { generatedAt: AT_ISO });

    const gen = judge.prompts[0]!.toLowerCase();
    expect(gen).toContain('concrete');
    expect(gen).toContain('unconstrained');
  });

  // The ask grew (best-of weighted 2x, a +1 buffer per intent, paired
  // constrained/unconstrained variants), so a fixed output budget could truncate
  // a large or verbose-locale pack mid-JSON - which parses to an EMPTY pack and a
  // not-assessed run. The token budget must scale with how many questions we ask.
  it('scales the judge output budget with the size of the ask', async () => {
    const small = recordingJudge(goodAnswer);
    await generateQueries(
      profile(),
      { judge: small, guard: new CostGuard({ maxSetupCostUsd: 0.05 }) },
      { count: 8, generatedAt: AT_ISO },
    );
    const big = recordingJudge(goodAnswer);
    await generateQueries(
      profile(),
      { judge: big, guard: new CostGuard({ maxSetupCostUsd: 0.2 }) },
      { count: 40, generatedAt: AT_ISO },
    );
    expect(big.maxTokens[0]!).toBeGreaterThan(small.maxTokens[0]!);
  });

  it('uses the current year for any time reference (never a stale/past year)', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    // AT_ISO is 2026; models otherwise default to their training-cutoff year
    // ("best phones in 2023"), which reads as stale.
    await generateQueries(profile(), { judge, guard }, { generatedAt: AT_ISO });

    const gen = judge.prompts[0]!;
    expect(gen).toContain('2026'); // the current year, from the injected clock
    expect(gen.toLowerCase()).toContain('current year');
    expect(gen.toLowerCase()).toContain('past year');
  });

  it('strips any competitor a misbehaving judge slips into the prompts', async () => {
    const answer = JSON.stringify({
      'best-of': ['Best kits?', 'Is Estes better than the rest?'],
      comparison: [],
      problem: [],
      trust: [],
    });
    const judge = recordingJudge(answer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const { pack } = await generateQueries(
      profile(),
      { judge, guard },
      { count: 20, generatedAt: AT_ISO },
    );

    expect(pack.queries.every((q) => !/Estes/i.test(q.prompt))).toBe(true);
    expect(pack.queries.map((q) => q.prompt)).toContain('Best kits?');
  });

  it('authorizes against the real output budget, not the 100-token judge estimate', async () => {
    const judge = recordingJudge(goodAnswer);
    // The old fixed ~100-output-token estimate (~$0.00017) would fit under this
    // cap; the real ~900-token generation budget does not, so it must skip.
    const guard = new CostGuard({ maxSetupCostUsd: 0.0003 });

    const { pack, skipped } = await generateQueries(
      profile(),
      { judge, guard },
      { generatedAt: AT_ISO },
    );

    expect(skipped).toBeDefined();
    expect(pack.queries).toEqual([]);
    expect(guard.costCapped).toBe(true);
    expect(judge.prompts).toEqual([]);
  });

  it('skips generation and never spends when it would exceed the setup cap', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard({ maxSetupCostUsd: 0.0000001 });

    const { pack, skipped } = await generateQueries(
      profile(),
      { judge, guard },
      { generatedAt: AT_ISO },
    );

    expect(pack.queries).toEqual([]);
    expect(skipped).toBeDefined();
    expect(guard.costCapped).toBe(true);
    expect(guard.spentUsd).toBe(0);
    expect(judge.prompts).toEqual([]);
  });

  it('degrades to an empty pack (never throws) when the judge errors', async () => {
    const judge: JudgeClient = {
      model: 'gpt-4o-mini',
      complete() {
        return Promise.reject(new Error('503 unavailable'));
      },
    };
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const { pack, skipped } = await generateQueries(
      profile(),
      { judge, guard },
      { generatedAt: AT_ISO },
    );

    expect(pack.queries).toEqual([]);
    expect(skipped).toContain('503');
    expect(guard.spentUsd).toBe(0);
  });
});
