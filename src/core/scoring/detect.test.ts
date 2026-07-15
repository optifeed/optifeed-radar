import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
} from '../types.js';
import { analyzeAnswer } from './detect.js';

function profile(over: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: SCHEMA_VERSION,
    domain: 'acme.example',
    brand: 'Acme',
    aliases: [],
    competitors: [],
    ...over,
  };
}

function answer(text: string, over: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    engine: 'openai',
    kind: 'parametric',
    prompt: 'best model rocket kits?',
    text,
    model: 'gpt-4o',
    costUsd: 0,
    ts: '2026-07-15T00:00:00.000Z',
    ...over,
  };
}

describe('analyzeAnswer - mention detection', () => {
  it('matches case- and accent-insensitively (non-English safe)', () => {
    const p = profile({ brand: 'Café Rio' });
    const r = analyzeAnswer(answer('Honestly I love Cafe Rio for lunch.'), p);
    expect(r.mentioned).toBe(true);
    expect(r.position).toBe(1);
    expect(r.entities).toEqual(['Café Rio']);
  });

  it('respects word boundaries (no substring false positives)', () => {
    const p = profile({ brand: 'Ace' });
    expect(analyzeAnswer(answer('Deep space exploration.'), p).mentioned).toBe(
      false,
    );
    expect(analyzeAnswer(answer('Ace Hardware is great.'), p).mentioned).toBe(
      true,
    );
  });

  it('detects the brand via an alias or the domain', () => {
    const p = profile({ brand: 'Acme Rockets', aliases: ['Acme'] });
    expect(analyzeAnswer(answer('Acme has good kits.'), p).mentioned).toBe(
      true,
    );
    expect(
      analyzeAnswer(answer('See acme.example for details.'), p).mentioned,
    ).toBe(true);
  });

  it('handles a competitor-only answer (brand absent, SoV still populated)', () => {
    const p = profile({ brand: 'Acme', competitors: ['Estes', 'Quest'] });
    const r = analyzeAnswer(answer('Estes makes the best beginner kits.'), p);
    expect(r.mentioned).toBe(false);
    expect(r.position).toBeNull();
    expect(r.entities).toEqual(['Estes']);
  });

  it('ranks position by first appearance among known entities', () => {
    const p = profile({ brand: 'Acme', competitors: ['Estes', 'Quest'] });
    const r = analyzeAnswer(
      answer('Top picks: Estes first, then Acme, then Quest.'),
      p,
    );
    expect(r.entities).toEqual(['Estes', 'Acme', 'Quest']);
    expect(r.position).toBe(2);
  });

  it('extracts cited domains from grounded citations', () => {
    const p = profile();
    const r = analyzeAnswer(
      answer('Acme is solid.', {
        kind: 'grounded',
        citations: ['https://acme.example/kits', 'https://blog.foo.com/rev'],
      }),
      p,
    );
    expect(r.citedDomains).toEqual(['acme.example', 'blog.foo.com']);
  });

  it('flags a generic-word brand as ambiguous for the judge pass', () => {
    const p = profile({ brand: 'Orange' });
    const r = analyzeAnswer(answer('I like fresh orange juice.'), p);
    expect(r.mentioned).toBe(true);
    expect(r.ambiguous).toBe(true);
  });

  it('reads sentiment from surrounding language', () => {
    const p = profile({ brand: 'Acme' });
    expect(
      analyzeAnswer(answer('Acme is the best, highly recommend it.'), p)
        .sentiment,
    ).toBe('positive');
    expect(
      analyzeAnswer(answer('Avoid Acme, it is a scam and unreliable.'), p)
        .sentiment,
    ).toBe('negative');
    expect(analyzeAnswer(answer('Acme exists.'), p).sentiment).toBe('neutral');
  });
});
