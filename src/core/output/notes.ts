/**
 * Pure helpers over a run's `notes: string[]` - the honesty-flag free text
 * carried on {@link DiscoverAndQueriesResult} (`core/run`), the abort path of
 * `runCheck`, and the MCP surfaces that join or render it. Deliberately NOT in
 * `terminal.ts`: that file's own docstring scopes it to TTY rendering
 * ("Consumes the report/envelope only - never re-derives from raw data"), but
 * `dedupeNotes` runs in `core/run` on the raw notes array BEFORE an envelope
 * exists, shaping data that later flows into persisted snapshots and MCP JSON,
 * not just a terminal's stdout. Living here instead keeps that shaping
 * data-shape logic (this file) separate from presentation (`terminal.ts`),
 * while `core/output/index.ts` re-exports both, so no import path a caller
 * already uses has to change.
 */

/**
 * Drop exact-duplicate notes, keeping first-seen order. Two independent judge
 * calls (competitor discovery, query generation) can fail against the same
 * outage and each push a note built from the same `judge error: ${message}`
 * template - byte-identical text, not merely similar. Showing the same
 * sentence twice tells a user nothing the first showing did not, so this
 * collapses exact repeats only; near-duplicates that differ by even one
 * character are left alone, since they may carry distinct information.
 *
 * Run AFTER each note is prefixed with its origin (`Competitor discovery: `,
 * `Query generation: `) - as a backstop, not the primary signal. Prefixing
 * keeps "two independent things failed" visible as two lines; this only
 * catches the case where a caller (or future call site) still manages to
 * produce two byte-identical notes.
 */
export function dedupeNotes(notes: string[]): string[] {
  return [...new Set(notes)];
}
