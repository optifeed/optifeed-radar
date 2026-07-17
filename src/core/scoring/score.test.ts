import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineId,
  type MentionResult,
  type Sentiment,
} from '../types.js';
import {
  aggregateSources,
  compositeScore,
  scoreEngine,
  shareOfVoice,
} from './score.js';

function mention(over: Partial<MentionResult> = {}): MentionResult {
  return {
    engine: 'openai',
    prompt: 'q',
    mentioned: false,
    position: null,
    sentiment: 'neutral',
    entities: [],
    citedDomains: [],
    ambiguous: false,
    ...over,
  };
}

function mentionAt(
  position: number,
  sentiment: Sentiment = 'neutral',
  engine: EngineId = 'openai',
): MentionResult {
  return mention({ engine, mentioned: true, position, sentiment });
}

describe('scoreEngine (published formula)', () => {
  it('reproduces the documented worked example → 53', () => {
    // 5 answers, 3 mentioned at positions 1,2,3 with sentiments +,0,0.
    const results = [
      mentionAt(1, 'positive'),
      mentionAt(2, 'neutral'),
      mentionAt(3, 'neutral'),
      mention({ mentioned: false }),
      mention({ mentioned: false }),
    ];
    const s = scoreEngine('openai', 'parametric', results);
    expect(s.mentionRate).toBeCloseTo(0.6, 10);
    expect(s.avgPosition).toBeCloseTo(2, 10); // avg rank WHEN mentioned (display)
    expect(s.mentions).toBe(3);
    expect(s.answers).toBe(5);
    // positionScore is coverage-aware: mean of 1/rank over ALL 5 answers.
    // (0.6*0.6 + 0.4*((1/1+1/2+1/3)/5)) * 1.05 = (0.36 + 0.1467)*1.05 = 0.532 → 53
    expect(s.score).toBe(53);
  });

  it('gives a mentioned-but-unranked answer mid-rank position credit, not zero', () => {
    // Prose praise with no numbered rank: position parses to null, but the
    // brand IS present. It must not be scored as absent (position 0) - it earns
    // the mid-rank default (rank 4 -> 1/4 credit).
    const results = [
      mention({ mentioned: true, position: null, sentiment: 'neutral' }),
      mention({ mentioned: true, position: null, sentiment: 'neutral' }),
    ];
    const s = scoreEngine('openai', 'parametric', results);
    expect(s.mentionRate).toBe(1);
    expect(s.avgPosition).toBeNull(); // no parsed ranks to average (display)
    // positionScore = (1/4 + 1/4) / 2 = 0.25; raw = 0.6*1 + 0.4*0.25 = 0.7 -> 70
    // (would be 60 if unranked mentions scored as absent).
    expect(s.score).toBe(70);
  });

  it('scores 0 with no mentions and reports a null avg position', () => {
    const s = scoreEngine('anthropic', 'parametric', [
      mention({ mentioned: false }),
      mention({ mentioned: false }),
    ]);
    expect(s.score).toBe(0);
    expect(s.avgPosition).toBeNull();
    expect(s.mentionRate).toBe(0);
  });
});

describe('compositeScore', () => {
  it('weights grounded engines higher than parametric', () => {
    const engines = [
      {
        engine: 'perplexity' as EngineId,
        kind: 'grounded' as const,
        score: 60,
        mentionRate: 0,
        avgPosition: null,
        answers: 1,
        mentions: 0,
      },
      {
        engine: 'anthropic' as EngineId,
        kind: 'parametric' as const,
        score: 40,
        mentionRate: 0,
        avgPosition: null,
        answers: 1,
        mentions: 0,
      },
    ];
    // (60*1.5 + 40*1.0) / (1.5 + 1.0) = 130 / 2.5 = 52
    expect(compositeScore(engines)).toBe(52);
  });

  // Live 2026-07-17: when the judge 400'd and no engine answered, `check` still
  // printed "AI Visibility Score: 0/100" and persisted score: 0 with NO honesty
  // flag - a total failure was indistinguishable from a real zero. The
  // laundering started here: `totalWeight === 0 ? 0 : ...` invented a 0 for an
  // empty engine list, and THIS TEST asserted that 0 as correct, locking the
  // bug in. Same class M14 already fixed for lint-feed (feedScore:
  // number|null): an unmeasured brand has NO score - it is not a brand that
  // scored zero (rule #6).
  it('is null (not a fabricated 0) when no engine produced a score', () => {
    expect(compositeScore([])).toBeNull();
  });
});

describe('shareOfVoice', () => {
  const profile: BrandProfile = {
    schema_version: SCHEMA_VERSION,
    domain: 'acme.example',
    brand: 'Acme',
    aliases: [],
    competitors: ['Estes', 'Quest'],
  };

  it('dedupes when a competitor list accidentally repeats the brand', () => {
    const p: BrandProfile = {
      schema_version: SCHEMA_VERSION,
      domain: 'acme.example',
      brand: 'Acme',
      aliases: [],
      competitors: ['Acme', 'Beta'], // brand duplicated in competitors
    };
    const rows = shareOfVoice(
      [mention({ mentioned: true, entities: ['Acme'] })],
      p,
    );
    const acmeRows = rows.filter((r) => r.name === 'Acme');
    expect(acmeRows).toHaveLength(1); // not double-counted
    expect(acmeRows[0]!.isBrand).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(['Acme', 'Beta']);
  });

  it('counts brand + competitor mentions and computes shares', () => {
    const results = [
      mention({ mentioned: true, entities: ['Acme', 'Estes'] }),
      mention({ mentioned: false, entities: ['Estes'] }),
      mention({ mentioned: true, entities: ['Acme'] }),
      mention({ mentioned: false, entities: ['Estes', 'Quest'] }),
    ];
    // counts: Acme 2, Estes 3, Quest 1; total 6.
    const rows = shareOfVoice(results, profile);
    expect(rows).toEqual([
      { name: 'Estes', isBrand: false, mentions: 3, sharePct: 50 },
      { name: 'Acme', isBrand: true, mentions: 2, sharePct: 33.3 },
      { name: 'Quest', isBrand: false, mentions: 1, sharePct: 16.7 },
    ]);
  });
});

describe('aggregateSources', () => {
  it('counts cited domains across answers, most-cited first', () => {
    const results = [
      mention({ citedDomains: ['acme.example', 'foo.com'] }),
      mention({ citedDomains: ['foo.com'] }),
      mention({ citedDomains: ['bar.com', 'foo.com'] }),
    ];
    expect(aggregateSources(results)).toEqual([
      { domain: 'foo.com', count: 3 },
      { domain: 'acme.example', count: 1 },
      { domain: 'bar.com', count: 1 },
    ]);
  });
});
