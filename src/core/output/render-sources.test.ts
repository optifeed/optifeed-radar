import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import type { VisibilityEnvelope } from './envelope.js';
import { FOOTER_CTA } from './footer.js';
import { renderSourcesText } from './terminal.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: [],
  competitors: ['Chipotle'],
};

function envelope(over: Partial<VisibilityEnvelope> = {}): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: '2026-07-15T00:00:00.000Z',
    domain: 'caferio.example',
    profile: PROFILE,
    score: 61,
    engines: [],
    shareOfVoice: [
      { name: 'Café Rio', isBrand: true, mentions: 3, sharePct: 60 },
      { name: 'Chipotle', isBrand: false, mentions: 2, sharePct: 40 },
    ],
    sources: [
      { domain: 'eater.com', count: 2 },
      { domain: 'caferio.example', count: 1 },
    ],
    mentions: [],
    answers: [],
    findings: [],
    sampling: {
      nPrompts: 4,
      nAnswers: 5,
      judged: 0,
      varianceNote: 'note',
    },
    ...over,
  };
}

describe('renderSourcesText', () => {
  it('lists cited source domains with their counts', () => {
    const out = renderSourcesText(envelope(), { color: false });
    expect(out).toContain('eater.com');
    expect(out).toContain('2');
    expect(out).toContain('caferio.example');
  });

  it('shows share of voice with a (you) marker on the brand row', () => {
    const out = renderSourcesText(envelope(), { color: false });
    expect(out).toContain('Café Rio');
    expect(out).toContain('(you)');
    expect(out).toContain('Chipotle');
    expect(out).toContain('60');
  });

  it('surfaces honesty notes for a partial run (rule #6)', () => {
    const out = renderSourcesText(envelope({ degraded: true }), {
      color: false,
    });
    expect(out.toLowerCase()).toContain('degraded');
  });

  it('ends with the single footer CTA and no em-dash', () => {
    const out = renderSourcesText(envelope(), { color: false });
    expect(out.trimEnd().endsWith(FOOTER_CTA)).toBe(true);
    expect(out).not.toContain('—');
  });

  it('notes when a run had no grounded citations (honest empty state)', () => {
    const out = renderSourcesText(envelope({ sources: [] }), { color: false });
    expect(out.toLowerCase()).toContain('no cited sources');
  });
});
