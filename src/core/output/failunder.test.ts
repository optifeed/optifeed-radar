import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import { VARIANCE_NOTE, type VisibilityEnvelope } from './envelope.js';
import { failUnder } from './failunder.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: [],
  competitors: [],
};

function envelope(
  score: number,
  honesty: Partial<
    Pick<VisibilityEnvelope, 'costCapped' | 'degraded' | 'skippedEngines'>
  > = {},
): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: '2026-07-15T00:00:00.000Z',
    domain: 'caferio.example',
    profile: PROFILE,
    score,
    engines: [],
    shareOfVoice: [],
    sources: [],
    mentions: [],
    answers: [],
    findings: [],
    sampling: {
      nPrompts: 3,
      nAnswers: 5,
      judged: 0,
      varianceNote: VARIANCE_NOTE,
    },
    ...honesty,
  };
}

describe('failUnder', () => {
  it('passes with exit code 0 when no threshold is set', () => {
    const r = failUnder(envelope(12));
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('passes when the score meets the threshold', () => {
    const r = failUnder(envelope(70), 70);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('fails with exit code 1 when the score is under the threshold', () => {
    const r = failUnder(envelope(69), 70);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.reason).toContain('69');
    expect(r.reason).toContain('70');
  });

  it('flags a partial (cost-capped) run as partial in the reason', () => {
    const r = failUnder(envelope(40, { costCapped: true }), 70);
    expect(r.passed).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.reason.toLowerCase()).toContain('partial');
  });

  it('flags a degraded run as partial even when it passes', () => {
    const r = failUnder(envelope(90, { degraded: true }), 70);
    expect(r.passed).toBe(true);
    expect(r.partial).toBe(true);
  });

  it('flags a run with skipped engines as partial (rule #6)', () => {
    // Only one engine had a key; the other three were skipped. Score is a
    // sliver of the full picture and must not read as full-confidence.
    const r = failUnder(
      envelope(72, {
        skippedEngines: [
          { engine: 'gemini', reason: 'no key' },
          { engine: 'perplexity', reason: 'no key' },
          { engine: 'anthropic', reason: 'no key' },
        ],
      }),
      70,
    );
    expect(r.passed).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.reason.toLowerCase()).toContain('partial');
  });

  it('is not partial on a clean run', () => {
    expect(failUnder(envelope(90), 70).partial).toBe(false);
  });
});
