import { describe, expect, it } from 'vitest';
import type { EngineAnswer, EngineId, EngineKind } from '../types.js';
import { answerRetrieved } from './retrieval.js';
import { compositeScore, effectiveWeight, SCORE_WEIGHTS } from './score.js';

function answer(over: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'grounded',
    prompt: 'best running shoes',
    text: 'Some answer.',
    model: 'gpt-5.4',
    costUsd: 0.01,
    ts: '2026-07-22T00:00:00.000Z',
    ...over,
  };
}

function engineScore(
  engine: EngineId,
  kind: EngineKind,
  score: number,
  answers: number,
  retrievedAnswers?: number,
) {
  return {
    engine,
    kind,
    score,
    mentionRate: 0.5,
    avgPosition: null,
    answers,
    mentions: 1,
    ...(retrievedAnswers === undefined ? {} : { retrievedAnswers }),
  };
}

describe('answerRetrieved', () => {
  it('is false for a grounded answer that shows no sign of having searched', () => {
    // The live smoke test found 7 of 8 OpenAI answers like this: tagged
    // grounded because grounded mode was REQUESTED, but the model answered
    // from its weights.
    expect(answerRetrieved(answer())).toBe(false);
  });

  it('is true when the engine reported the queries it ran', () => {
    expect(
      answerRetrieved(answer({ fanoutQueries: ['best running shoes'] })),
    ).toBe(true);
  });

  it('is true on citations alone (Perplexity never exposes its queries)', () => {
    expect(
      answerRetrieved(
        answer({ engine: 'perplexity', citations: ['https://example.com'] }),
      ),
    ).toBe(true);
  });

  it('is false for a parametric answer, which by definition ran no search', () => {
    expect(answerRetrieved(answer({ kind: 'parametric' }))).toBe(false);
  });

  it('trusts the tag for an engine that cannot report evidence', () => {
    // A future provider that grounds without exposing queries or citations
    // must not be silently downgraded; absence of evidence is only evidence of
    // absence where the provider is known to report it.
    expect(
      answerRetrieved(answer({ engine: 'anthropic', kind: 'grounded' })),
    ).toBe(true);
  });
});

describe('effectiveWeight', () => {
  it('gives a parametric engine the parametric weight', () => {
    expect(effectiveWeight(engineScore('anthropic', 'parametric', 50, 8))).toBe(
      SCORE_WEIGHTS.parametricWeight,
    );
  });

  it('gives the full grounded premium when every answer actually searched', () => {
    expect(effectiveWeight(engineScore('gemini', 'grounded', 50, 7, 7))).toBe(
      SCORE_WEIGHTS.groundedWeight,
    );
  });

  it('earns none of the premium when no answer searched', () => {
    expect(effectiveWeight(engineScore('openai', 'grounded', 50, 8, 0))).toBe(
      SCORE_WEIGHTS.parametricWeight,
    );
  });

  it('earns the premium in proportion to how many answers searched', () => {
    // 1 of 8 searched -> an eighth of the 0.5 premium.
    expect(
      effectiveWeight(engineScore('openai', 'grounded', 50, 8, 1)),
    ).toBeCloseTo(1.0625, 6);
  });

  it('trusts a pre-existing grounded score with no retrieval count (old snapshot)', () => {
    // Snapshots written before this field existed must re-score to the same
    // number they reported, not silently lose the premium.
    expect(effectiveWeight(engineScore('gemini', 'grounded', 50, 7))).toBe(
      SCORE_WEIGHTS.groundedWeight,
    );
  });
});

describe('compositeScore weights by actual retrieval', () => {
  it('does not hand the grounded premium to an engine that never searched', () => {
    // The live case: openai 58 (grounded mode, 1 of 8 actually searched)
    // against gemini 70 (7 of 7 searched).
    const engines = [
      engineScore('openai', 'grounded', 58, 8, 1),
      engineScore('gemini', 'grounded', 70, 7, 7),
    ];
    const weighted = 58 * 1.0625 + 70 * 1.5;
    expect(compositeScore(engines)).toBe(Math.round(weighted / (1.0625 + 1.5)));
  });

  it('is unchanged for a run where every grounded answer searched', () => {
    const engines = [
      engineScore('openai', 'grounded', 60, 4, 4),
      engineScore('anthropic', 'parametric', 40, 4),
    ];
    expect(compositeScore(engines)).toBe(Math.round((60 * 1.5 + 40) / 2.5));
  });
});
