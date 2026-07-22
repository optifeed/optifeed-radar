/**
 * Render a {@link SnapshotDiff} (M9): what a brand won or lost between two
 * `check` runs. Consumes the diff only - never re-derives. Honest about the
 * three caveats the diff carries (prompt set changed, engine set changed,
 * either run partial) so a delta is never read as full-confidence when it is
 * not (rule #6). Ends with the single footer CTA; no em-dash.
 */
import pc from 'picocolors';
import type { SnapshotDiff } from './diff.js';
import { FOOTER_CTA } from './footer.js';
import { renderNoteBlock, type TextRenderOptions } from './terminal.js';

/** A score delta with an explicit sign, e.g. `+7`, `-4`, `+0`. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Stable pretty JSON of the diff (carries `schema_version`). */
export function renderDiffJson(diff: SnapshotDiff): string {
  return JSON.stringify(diff, null, 2);
}

/** Plain-text diff report for `diff <domain>`. */
export function renderDiffText(
  diff: SnapshotDiff,
  opts: TextRenderOptions = {},
): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const lines: string[] = [];

  lines.push(c.bold(`AI Visibility change: ${diff.domain}`));
  lines.push(`from ${diff.from}`);
  lines.push(`to   ${diff.to}`);
  lines.push('');
  lines.push(
    c.bold(
      diff.scoreDelta === null
        ? 'Score: not comparable (a run was not assessed - no score)'
        : `Score: ${signed(diff.scoreDelta)}`,
    ),
  );
  lines.push('');

  lines.push('Per engine:');
  for (const e of diff.engines) {
    lines.push(`  ${e.engine}  ${signed(e.scoreDelta)}`);
    for (const p of e.wonPrompts) lines.push(`    ${c.green('won ')} ${p}`);
    for (const p of e.lostPrompts) lines.push(`    ${c.red('lost')} ${p}`);
  }
  lines.push('');

  // Honesty caveats (rule #6): each qualifies how much the deltas mean.
  const caveats: string[] = [];
  if (diff.promptSetChanged) {
    caveats.push(
      'The prompt set changed between runs, so the deltas are not apples-to-apples; won/lost cover only the prompts asked in both.',
    );
  }
  if (diff.engineSetChanged) {
    caveats.push(
      'An engine appeared in only one run, so the headline delta partly reflects an engine entering or leaving the sample.',
    );
  }
  if (diff.scoringChanged) {
    caveats.push(
      'The two runs used different scoring methodologies, so this delta is methodology-driven, not a real change in visibility.',
    );
  }
  if (diff.retrievalChanged) {
    caveats.push(
      'An engine chose to search on a different share of its answers this time, which changes its weight in the headline score. The per-engine deltas below cannot show this - those scores do not depend on the weight.',
    );
  }
  if (diff.partial) {
    caveats.push(
      // Deliberately does NOT list causes: the renderer receives only the diff,
      // not the two envelopes, so any list here would be guessed. The old
      // wording named three causes and a fourth signal now exists. Run
      // `sources <domain>` on either snapshot for the specific reason.
      'At least one run was partial, so this change is not full-confidence.',
    );
  }
  lines.push(...renderNoteBlock('Notes', caveats, c));

  lines.push(FOOTER_CTA);
  return lines.join('\n');
}
