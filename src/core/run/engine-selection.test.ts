import { describe, it, expect } from 'vitest';
import { selectEngines } from './engine-selection.js';

describe('selectEngines', () => {
  it('classifies an empty token list as "none" (no preference)', () => {
    expect(selectEngines([])).toEqual({ kind: 'none' });
    expect(selectEngines([''])).toEqual({ kind: 'none' });
  });

  it('returns the recognized engines, dropping unknown tokens', () => {
    expect(selectEngines(['openai', 'nope', 'gemini'])).toEqual({
      kind: 'engines',
      engines: ['openai', 'gemini'],
    });
  });

  it('normalizes case and whitespace', () => {
    expect(selectEngines([' OpenAI ', 'PERPLEXITY'])).toEqual({
      kind: 'engines',
      engines: ['openai', 'perplexity'],
    });
  });

  it('classifies an all-unknown non-empty selection as "empty" (caller must abort, never widen)', () => {
    expect(selectEngines(['gpt4', 'bard'])).toEqual({ kind: 'empty' });
  });
});
