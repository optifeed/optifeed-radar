import { describe, expect, it } from 'vitest';
import { extractBalanced, fold, indexOfTerm, mentionsTerm } from './text.js';

/** Convenience: fold the haystack the way callers do, then match. */
function has(haystack: string, term: string): boolean {
  return mentionsTerm(fold(haystack), term);
}

describe('fold', () => {
  it('lowercases and strips diacritics', () => {
    expect(fold('Café RÖ')).toBe(
      'cafe rö'.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    );
    expect(fold('Café')).toBe('cafe');
  });
});

describe('indexOfTerm / mentionsTerm', () => {
  it('matches on Latin word boundaries, not substrings', () => {
    expect(has('deep space exploration', 'ace')).toBe(false);
    expect(has('Ace Hardware is great', 'ace')).toBe(true);
  });

  it('matches accented terms after folding', () => {
    expect(has('I love Café Rio', 'café')).toBe(true);
    expect(has('I love Cafe Rio', 'Café')).toBe(true);
  });

  it('matches Cyrillic and Greek names (space-delimited boundaries)', () => {
    expect(has('Я рекомендую Яндекс сервис', 'Яндекс')).toBe(true);
    expect(has('это яндекссовый провал', 'Яндекс')).toBe(false); // inside a longer word
    expect(has('η νικη ειναι κοντα', 'νικη')).toBe(true);
  });

  it('matches CJK names by substring (no word boundaries in the script)', () => {
    expect(has('私は楽天をお勧めします', '楽天')).toBe(true);
    expect(has('日立の製品は良い', '日立')).toBe(true);
    expect(has('これは別の会社です', '楽天')).toBe(false);
  });

  it('matches names with non-word edge characters', () => {
    expect(has('is C++ better than Rust', 'C++')).toBe(true);
    expect(has('we use .NET here', '.NET')).toBe(true);
  });

  it('anchors domains on host boundaries', () => {
    expect(has('visit acme.com today', 'acme.com')).toBe(true);
    expect(has('go to shop.acme.com now', 'acme.com')).toBe(true); // subdomain
    expect(has('beware myacme.com scams', 'acme.com')).toBe(false); // substring
    expect(has('notacme.com is fake', 'acme.com')).toBe(false);
  });

  it('returns -1 for an empty term and reports first match index', () => {
    expect(indexOfTerm('anything', '')).toBe(-1);
    expect(indexOfTerm(fold('go to Ace now'), 'ace')).toBe(6);
  });
});

describe('extractBalanced', () => {
  it('returns the first balanced object, ignoring later braces in prose', () => {
    expect(
      extractBalanced(
        'Here you go:\n{"a":["x"]}\nlet me know {details}.',
        '{',
        '}',
      ),
    ).toBe('{"a":["x"]}');
  });

  it('respects braces inside string literals (and escaped quotes)', () => {
    expect(extractBalanced('{"a":"}{","b":"\\""}', '{', '}')).toBe(
      '{"a":"}{","b":"\\""}',
    );
  });

  it('handles arrays and nested structures', () => {
    expect(extractBalanced('x [1,[2,3]] y ]', '[', ']')).toBe('[1,[2,3]]');
  });

  it('returns null when there is no opening delimiter or it never closes', () => {
    expect(extractBalanced('no braces here', '{', '}')).toBeNull();
    expect(extractBalanced('{"a": 1', '{', '}')).toBeNull();
  });
});
