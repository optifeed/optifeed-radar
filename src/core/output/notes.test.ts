import { describe, expect, it } from 'vitest';
import { dedupeNotes } from './notes.js';

describe('dedupeNotes', () => {
  it('drops exact-duplicate notes, keeping the first occurrence', () => {
    // The real trigger: two independent judge calls (competitor discovery,
    // query generation) hitting the SAME provider outage produce byte-identical
    // "judge error: HTTP 429: ..." notes.
    const note =
      'judge error: HTTP 429: You have no credits remaining. Add credits to continue.';
    expect(dedupeNotes([note, note])).toEqual([note]);
  });

  it('preserves first-seen order across distinct notes', () => {
    expect(dedupeNotes(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves near-duplicates (not byte-identical) alone', () => {
    const a = 'judge error: HTTP 429: rate limited';
    const b = 'judge error: HTTP 429: rate limited (retry later)';
    expect(dedupeNotes([a, b])).toEqual([a, b]);
  });

  it('handles an empty list', () => {
    expect(dedupeNotes([])).toEqual([]);
  });

  it('still dedupes after each note is prefixed with its origin (backstop role)', () => {
    // The primary fix is prefixing at the point each note is built
    // (`Competitor discovery: ...` / `Query generation: ...`), which already
    // distinguishes two failures that happen to share the same underlying
    // reason. dedupeNotes is the backstop for the case where two prefixed
    // notes still end up byte-identical (e.g. the same step somehow reporting
    // twice).
    const a = 'Competitor discovery: judge error: HTTP 429: no credits';
    expect(dedupeNotes([a, a])).toEqual([a]);
  });
});
