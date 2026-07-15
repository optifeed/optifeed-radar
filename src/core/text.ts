/**
 * Shared text-matching utilities (used by scoring detection and query
 * competitor exclusion). Pure, no dependencies.
 *
 * Matching is Unicode-aware: names in space-delimited scripts (Latin, Cyrillic,
 * Greek, ...) match on word boundaries; names in scripts without word
 * separators (CJK) match by substring, since a `\b`-style boundary never fires
 * there and would silently miss every mention.
 */

/** A "word" character for boundary purposes: any Unicode letter/number or `_`. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Scripts that do not delimit words with spaces - matched by substring. */
const SCRIPTLESS = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

/** Lowercase and strip diacritics so "Café" folds to "cafe". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isWordChar(ch: string): boolean {
  return ch !== '' && WORD_CHAR.test(ch);
}

/**
 * First index of `term` in an already-folded `haystack`, respecting a
 * Unicode-aware word boundary, or -1. `term` is folded internally.
 *
 * A boundary holds at an edge when the character just outside the match and the
 * term's own edge character are not both word characters - so "ace" matches in
 * "Ace Hardware" but not in "space", "C++" matches next to spaces/punctuation,
 * and "acme.com" matches "shop.acme.com" but not "myacme.com". CJK terms skip
 * the boundary check (their scripts have no word separators).
 */
export function indexOfTerm(haystack: string, term: string): number {
  const needle = fold(term).trim();
  if (!needle) return -1;

  if (SCRIPTLESS.test(needle)) return haystack.indexOf(needle);

  const first = needle[0] ?? '';
  const last = needle[needle.length - 1] ?? '';
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    const before = idx > 0 ? (haystack[idx - 1] ?? '') : '';
    const after = haystack[idx + needle.length] ?? '';
    const leftOk = !isWordChar(before) || !isWordChar(first);
    const rightOk = !isWordChar(after) || !isWordChar(last);
    if (leftOk && rightOk) return idx;
    from = idx + 1;
  }
}

/** Whether `term` appears in an already-folded `haystack` (boundary-aware). */
export function mentionsTerm(haystack: string, term: string): boolean {
  return indexOfTerm(haystack, term) !== -1;
}

/**
 * Extract the first balanced `open`...`close` block from `text`, or null.
 *
 * Depth-tracks nested delimiters and ignores any that appear inside a JSON
 * string literal (respecting `\"` escapes), so trailing prose braces do not
 * corrupt the slice (`lastIndexOf` would). Used to pull a JSON object/array out
 * of chatty LLM output.
 */
export function extractBalanced(
  text: string,
  open: string,
  close: string,
): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
