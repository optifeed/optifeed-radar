import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import type { JudgeClient } from '../types.js';
import {
  discoverCompetitors,
  dropSelfReferences,
  parseCompetitors,
} from './competitors.js';

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

  // Live 2026-07-20 (doremusic.com, during the judge measurement): every judge
  // returned the brand ITSELF under a variant spelling - gpt-5.4 gave "Dore
  // Müzik" and "Do Re Müzik Market", gemini-flash-latest gave "Do Re Mi Müzik".
  // The prompt said "Do not include the brand itself" but named only the brand
  // string, so the model never saw the spellings it had to avoid, and nothing
  // downstream filtered them - the brand landed in its own share-of-voice table
  // as a rival, inflating a competitor that IS you (rule #6, fake precision).
  it('names the brand aliases in the prompt so the judge can avoid them', async () => {
    const judge = recordingJudge('["Zuhal Müzik"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await discoverCompetitors(
      { brand: 'doremusic', aliases: ['Do Re Müzik', 'Dore Music'] },
      { judge, guard },
    );

    expect(judge.prompts[0]).toContain('Do Re Müzik');
    expect(judge.prompts[0]).toContain('Dore Music');
  });

  it('drops the brand from its own competitor list when the judge returns it', async () => {
    const judge = recordingJudge(
      '["Do Re Müzik Market", "Zuhal Müzik", "DOREMUSIC"]',
    );
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'doremusic', aliases: ['Do Re Müzik'] },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Zuhal Müzik']);
  });

  // The 8-name cap is applied to what we KEEP, not to what the judge said:
  // filtering after the slice let self-references eat competitor slots, so a
  // judge that opened with three spellings of the brand returned five rivals
  // when eight were sitting further down its own list.
  it('fills the competitor cap with real rivals, not with names that were the brand', async () => {
    const names = [
      'Doremusic',
      'Do Re Music',
      'doremusic.com',
      ...Array.from({ length: 8 }, (_, i) => `Rival ${i + 1}`),
    ];
    const judge = recordingJudge(JSON.stringify(names));
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'doremusic', aliases: ['Do Re Müzik'] },
      { judge, guard },
    );

    expect(result.competitors).toEqual([
      'Rival 1',
      'Rival 2',
      'Rival 3',
      'Rival 4',
      'Rival 5',
      'Rival 6',
      'Rival 7',
      'Rival 8',
    ]);
  });

  // The filter matches whole terms, not shared words: a rival is dropped only
  // when the brand's own name is in it (or it is in the brand's name), so
  // "Ace Rental" survives a brand called "Ace Hardware".
  it('keeps a genuine rival that merely shares a word with the brand', () => {
    expect(
      dropSelfReferences(['Ace Rental', 'Hardware Depot'], ['Ace Hardware']),
    ).toEqual(['Ace Rental', 'Hardware Depot']);
  });

  it('drops a self-reference that only differs by spacing, case or accents', () => {
    expect(
      dropSelfReferences(
        ['Do Re Music', 'DOREMUSIC', 'Café Rio Grill', 'Chipotle'],
        ['doremusic', 'Café Rio'],
      ),
    ).toEqual(['Chipotle']);
  });

  it('returns an empty list (never throws) when every name was the brand', () => {
    expect(dropSelfReferences(['Acme', 'ACME Inc'], ['Acme'])).toEqual([]);
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

describe('business classification (M5a)', () => {
  it('parses businessType and competitors from one judge call', async () => {
    const judge = recordingJudge(
      '{"businessType":"retailer","competitors":["Zuhal Müzik","MyDukkan"]}',
    );
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'doremusic' },
      { judge, guard },
    );

    expect(result.businessType).toBe('retailer');
    expect(result.competitors).toEqual(['Zuhal Müzik', 'MyDukkan']);
  });

  // A judge that ignores the new shape must degrade, not break: the competitor
  // list is the older and more important half of this call (lesson #4).
  it('still accepts a bare array, with no businessType', async () => {
    const judge = recordingJudge('["Estes", "Quest"]');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Estes', 'Quest']);
    expect(result.businessType).toBeUndefined();
  });

  it('ignores an unknown businessType rather than trusting it', async () => {
    const judge = recordingJudge(
      '{"businessType":"wholesaler","competitors":["Estes"]}',
    );
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'Acme' },
      { judge, guard },
    );

    expect(result.businessType).toBeUndefined();
    expect(result.competitors).toEqual(['Estes']);
  });

  it('still drops self-references inside the object shape', async () => {
    const judge = recordingJudge(
      '{"businessType":"retailer","competitors":["Do Re Music","Zuhal Müzik"]}',
    );
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    const result = await discoverCompetitors(
      { brand: 'doremusic', aliases: ['Do Re Müzik'] },
      { judge, guard },
    );

    expect(result.competitors).toEqual(['Zuhal Müzik']);
  });

  // The M14 review already fixed this exact class once ({"Products":[...]} read
  // as 0 products because the wrapper key was matched case-sensitively). The
  // object branch must never be a WORSE parser than the array branch it
  // replaced: if it finds no competitors, fall back rather than return none.
  it('does not lose competitors to an unexpected wrapper key or casing', async () => {
    for (const text of [
      '{"Competitors":["Estes","Quest"]}',
      '{"rivals":["Estes","Quest"]}',
    ]) {
      const judge = recordingJudge(text);
      const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

      const result = await discoverCompetitors(
        { brand: 'Acme' },
        { judge, guard },
      );

      expect(result.competitors).toEqual(['Estes', 'Quest']);
    }
  });

  // A silently-dropped classification means the whole seller axis never
  // engages and a shop is scored on maker questions again, which is the bug
  // M5a exists to fix - so accept the casing models actually emit.
  it('reads businessType however the model cased the key', async () => {
    for (const text of [
      '{"business_type":"retailer","competitors":["A"]}',
      '{"BusinessType":"retailer","competitors":["A"]}',
    ]) {
      const judge = recordingJudge(text);
      const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

      const result = await discoverCompetitors(
        { brand: 'Acme' },
        { judge, guard },
      );

      expect(result.businessType).toBe('retailer');
    }
  });

  it('asks the judge to classify and to match rivals to that classification', async () => {
    const judge = recordingJudge('{"businessType":"maker","competitors":[]}');
    const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

    await discoverCompetitors({ brand: 'Acme' }, { judge, guard });

    expect(judge.prompts[0]).toContain('businessType');
    expect(judge.prompts[0]).toContain('rival shops');
  });
});
