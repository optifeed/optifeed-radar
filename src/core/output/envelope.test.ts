import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type Finding,
  type ScoreReport,
} from '../types.js';
import { VARIANCE_NOTE, buildEnvelope, isPartialRun } from './envelope.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: ['CafeRio'],
  competitors: ['Chipotle', 'Qdoba'],
};

function score(overrides: Partial<ScoreReport> = {}): ScoreReport {
  return {
    schema_version: SCHEMA_VERSION,
    domain: 'caferio.example',
    score: 61,
    engines: [
      {
        engine: 'openai',
        kind: 'parametric',
        score: 92,
        mentionRate: 0.66,
        avgPosition: 1,
        answers: 2,
        mentions: 1,
      },
    ],
    mentions: [
      {
        engine: 'openai',
        prompt: 'best fast-casual mexican?',
        mentioned: true,
        position: 1,
        sentiment: 'positive',
        entities: ['Café Rio'],
        citedDomains: [],
        ambiguous: false,
      },
    ],
    shareOfVoice: [
      { name: 'Café Rio', isBrand: true, mentions: 1, sharePct: 100 },
    ],
    sources: [],
    sampling: { answers: 2, judged: 0, judgeRateCap: 0.3 },
    generatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function answers(): EngineAnswer[] {
  return [
    {
      engine: 'openai',
      kind: 'parametric',
      prompt: 'best fast-casual mexican?',
      text: 'Café Rio is a great choice.',
      model: 'gpt-4o-mini-2024-07-18',
      costUsd: 0.0001,
      ts: '2026-07-15T00:00:00.000Z',
    },
    {
      engine: 'openai',
      kind: 'parametric',
      prompt: 'where to eat cheap burritos?',
      text: 'Try Chipotle.',
      model: 'gpt-4o-mini-2024-07-18',
      costUsd: 0.0001,
      ts: '2026-07-15T00:00:00.000Z',
    },
  ];
}

describe('buildEnvelope', () => {
  it('carries the headline score, profile, and scoring detail', () => {
    const env = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      generatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(env.schema_version).toBe(SCHEMA_VERSION);
    expect(env.generatedAt).toBe('2026-07-15T12:00:00.000Z');
    expect(env.domain).toBe('caferio.example');
    expect(env.profile).toEqual(PROFILE);
    // Hard rule #6: the ONE headline number is M7's score.
    expect(env.score).toBe(61);
    expect(env.engines).toEqual(score().engines);
    expect(env.mentions).toEqual(score().mentions);
    expect(env.shareOfVoice).toEqual(score().shareOfVoice);
  });

  it('surfaces audit findings inside the check envelope (rule #6)', () => {
    const findings: Finding[] = [
      { id: 'robots-gptbot', severity: 'error', message: 'GPTBot blocked' },
    ];
    const env = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      auditFindings: findings,
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    // Audit findings appear as findings, never as a competing audit score.
    expect(env.findings).toEqual(findings);
    expect(env).not.toHaveProperty('auditScore');
  });

  it('derives honest sampling from distinct prompts and the judge pass', () => {
    const env = buildEnvelope({
      profile: PROFILE,
      score: score({ sampling: { answers: 6, judged: 2, judgeRateCap: 0.3 } }),
      answers: answers(),
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(env.sampling.nPrompts).toBe(2); // two distinct prompts
    expect(env.sampling.nAnswers).toBe(6);
    expect(env.sampling.judged).toBe(2);
    expect(env.sampling.varianceNote).toBe(VARIANCE_NOTE);
  });

  it('embeds raw answers as evidence for the renderers (no re-derive)', () => {
    const env = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(env.answers).toEqual(answers());
  });

  it('propagates honesty flags and omits them when the run is clean', () => {
    const clean = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(clean.costCapped).toBeUndefined();
    expect(clean.skippedEngines).toBeUndefined();
    expect(clean.degraded).toBeUndefined();

    const partial = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      honesty: {
        costCapped: true,
        degraded: true,
        skippedEngines: [{ engine: 'gemini', reason: 'no key' }],
      },
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(partial.costCapped).toBe(true);
    expect(partial.degraded).toBe(true);
    expect(partial.skippedEngines).toEqual([
      { engine: 'gemini', reason: 'no key' },
    ]);
  });

  it('defaults findings to an empty array when no audit ran', () => {
    const env = buildEnvelope({
      profile: PROFILE,
      score: score(),
      answers: answers(),
      generatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(env.findings).toEqual([]);
  });
});

describe('isPartialRun', () => {
  it('is false for a clean run', () => {
    expect(isPartialRun({})).toBe(false);
  });

  it('is true for any single honesty flag (cost-capped, degraded, or skipped)', () => {
    expect(isPartialRun({ costCapped: true })).toBe(true);
    expect(isPartialRun({ degraded: true })).toBe(true);
    expect(
      isPartialRun({
        skippedEngines: [{ engine: 'gemini', reason: 'no key' }],
      }),
    ).toBe(true);
  });

  it('is false when skippedEngines is present but empty', () => {
    expect(isPartialRun({ skippedEngines: [] })).toBe(false);
  });
});
