import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineId,
  type EngineScore,
  type MentionResult,
} from '../types.js';
import { VARIANCE_NOTE, type VisibilityEnvelope } from './envelope.js';
import { type SnapshotDiff, diffEnvelopes } from './diff.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: [],
  competitors: [],
};

function mention(
  engine: EngineId,
  prompt: string,
  mentioned: boolean,
): MentionResult {
  return {
    engine,
    prompt,
    mentioned,
    position: mentioned ? 1 : null,
    sentiment: mentioned ? 'positive' : 'neutral',
    entities: [],
    citedDomains: [],
    ambiguous: false,
  };
}

function engineScore(engine: EngineId, score: number): EngineScore {
  return {
    engine,
    kind: 'parametric',
    score,
    mentionRate: 0,
    avgPosition: null,
    answers: 0,
    mentions: 0,
  };
}

function envelope(
  generatedAt: string,
  score: number,
  engines: EngineScore[],
  mentions: MentionResult[],
): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt,
    domain: 'caferio.example',
    profile: PROFILE,
    score,
    engines,
    shareOfVoice: [],
    sources: [],
    mentions,
    answers: [],
    findings: [],
    sampling: {
      nPrompts: 3,
      nAnswers: 5,
      judged: 0,
      varianceNote: VARIANCE_NOTE,
    },
  };
}

const A = envelope(
  '2026-07-01T00:00:00.000Z',
  50,
  [engineScore('openai', 60), engineScore('perplexity', 40)],
  [
    mention('openai', 'p1', true),
    mention('openai', 'p2', false),
    mention('openai', 'p3', true),
    mention('perplexity', 'p1', false),
    mention('perplexity', 'p2', true),
  ],
);

const B = envelope(
  '2026-07-15T00:00:00.000Z',
  58,
  [engineScore('openai', 70), engineScore('perplexity', 45)],
  [
    mention('openai', 'p1', true),
    mention('openai', 'p2', true), // won
    mention('openai', 'p3', false), // lost
    mention('perplexity', 'p1', true), // won
    mention('perplexity', 'p2', true),
  ],
);

function golden(): SnapshotDiff {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../test/fixtures/output/golden-diff.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as SnapshotDiff;
}

describe('diffEnvelopes', () => {
  it('reproduces the checked-in golden diff (won/lost per engine, deltas)', () => {
    expect(diffEnvelopes(A, B)).toEqual(golden());
  });

  it('reports the headline score delta and per-engine deltas', () => {
    const diff = diffEnvelopes(A, B);
    expect(diff.scoreDelta).toBe(8);
    const openai = diff.engines.find((e) => e.engine === 'openai');
    expect(openai?.scoreDelta).toBe(10);
    expect(openai?.wonPrompts).toEqual(['p2']);
    expect(openai?.lostPrompts).toEqual(['p3']);
  });

  it('flags an unchanged prompt set as not changed', () => {
    expect(diffEnvelopes(A, B).promptSetChanged).toBe(false);
  });

  it('treats a prompt mentioned in ANY answer as mentioned for that prompt', () => {
    const a = envelope(
      't1',
      0,
      [engineScore('openai', 0)],
      [mention('openai', 'p1', false)],
    );
    // Two answers to the same prompt: one miss, one hit -> counts as mentioned.
    const b = envelope(
      't2',
      0,
      [engineScore('openai', 0)],
      [mention('openai', 'p1', false), mention('openai', 'p1', true)],
    );
    const openai = diffEnvelopes(a, b).engines.find(
      (e) => e.engine === 'openai',
    );
    expect(openai?.wonPrompts).toEqual(['p1']);
    expect(openai?.lostPrompts).toEqual([]);
  });
});

describe('diffEnvelopes with a changed prompt set', () => {
  it('flags the change and only compares prompts present in both runs', () => {
    // B' drops p3, adds p4 for openai: the pack was regenerated/edited.
    const bChanged = envelope(
      '2026-07-15T00:00:00.000Z',
      58,
      [engineScore('openai', 70)],
      [
        mention('openai', 'p1', true),
        mention('openai', 'p2', true), // won (present in both)
        mention('openai', 'p4', true), // new prompt, NOT a "win"
      ],
    );
    const aOpenaiOnly = envelope(
      '2026-07-01T00:00:00.000Z',
      50,
      [engineScore('openai', 60)],
      [
        mention('openai', 'p1', true),
        mention('openai', 'p2', false),
        mention('openai', 'p3', true), // removed prompt, NOT a "loss"
      ],
    );

    const diff = diffEnvelopes(aOpenaiOnly, bChanged);
    expect(diff.promptSetChanged).toBe(true);
    const openai = diff.engines.find((e) => e.engine === 'openai');
    expect(openai?.wonPrompts).toEqual(['p2']); // p4 excluded (new)
    expect(openai?.lostPrompts).toEqual([]); // p3 excluded (removed)
  });
});
