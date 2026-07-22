import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../types.js';
import type { SnapshotDiff } from './diff.js';
import { FOOTER_CTA } from './footer.js';
import { renderDiffJson, renderDiffText } from './render-diff.js';

const DIFF: SnapshotDiff = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  from: '2026-07-10T00:00:00.000Z',
  to: '2026-07-15T00:00:00.000Z',
  scoreDelta: 7,
  engines: [
    {
      engine: 'openai',
      scoreDelta: 12,
      wonPrompts: ['best model rocket kits?'],
      lostPrompts: [],
    },
    {
      engine: 'gemini',
      scoreDelta: -4,
      wonPrompts: [],
      lostPrompts: ['starter rocket for beginners?'],
    },
  ],
  promptSetChanged: false,
  engineSetChanged: false,
  scoringChanged: false,
  retrievalChanged: false,
  partial: false,
};

describe('renderDiffText', () => {
  it('shows the domain, both timestamps, and the signed headline delta', () => {
    const out = renderDiffText(DIFF, { color: false });
    expect(out).toContain('acme.example');
    expect(out).toContain(DIFF.from);
    expect(out).toContain(DIFF.to);
    expect(out).toContain('+7'); // headline score delta, signed
  });

  it('lists per-engine deltas with won and lost prompts', () => {
    const out = renderDiffText(DIFF, { color: false });
    expect(out).toContain('openai');
    expect(out).toContain('+12');
    expect(out).toContain('best model rocket kits?'); // won
    expect(out).toContain('gemini');
    expect(out).toContain('-4');
    expect(out).toContain('starter rocket for beginners?'); // lost
  });

  it('ends with the single footer CTA', () => {
    const out = renderDiffText(DIFF, { color: false });
    expect(out.trimEnd().endsWith(FOOTER_CTA)).toBe(true);
  });

  it('flags a changed prompt set, a changed engine set, and a partial run (rule #6)', () => {
    const out = renderDiffText(
      {
        ...DIFF,
        promptSetChanged: true,
        engineSetChanged: true,
        partial: true,
      },
      { color: false },
    );
    expect(out.toLowerCase()).toContain('prompt set');
    expect(out.toLowerCase()).toContain('engine');
    expect(out.toLowerCase()).toContain('partial');
  });

  it('warns when the two runs used different scoring methodologies (rule #2)', () => {
    const out = renderDiffText(
      { ...DIFF, scoringChanged: true },
      { color: false },
    );
    expect(out.toLowerCase()).toContain('scoring');
  });
});

describe('renderDiffJson', () => {
  it('is the stable diff object as pretty JSON (carries schema_version)', () => {
    expect(JSON.parse(renderDiffJson(DIFF))).toEqual(DIFF);
  });
});

describe('the retrieval caveat is rendered, not only serialized', () => {
  it('explains a headline move that the per-engine deltas cannot show', () => {
    const out = renderDiffText(
      { ...DIFF, retrievalChanged: true },
      { color: false },
    );
    expect(out.toLowerCase()).toContain('search');
  });

  it('stays quiet when the retrieval rate held steady', () => {
    const out = renderDiffText(
      { ...DIFF, retrievalChanged: false },
      { color: false },
    );
    expect(out.toLowerCase()).not.toContain('chose to search');
  });
});
