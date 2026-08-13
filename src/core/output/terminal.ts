/**
 * Terminal (plain-text) rendering over the M8 contract (M9). Consumes the
 * report/envelope only - never re-derives from raw data. Honest footer, no
 * em-dash. Color is via picocolors and fully optional (off = clean capture).
 */
import pc from 'picocolors';
import type { AuditReport } from '../audit/index.js';
import type { ShareOfVoiceRow } from '../types.js';
import {
  VARIANCE_MARKER,
  isWiderEstimate,
  retrievalLine,
  varianceNote,
} from './variance.js';
import {
  isPartialRun,
  type PartialRunLike,
  type VisibilityEnvelope,
} from './envelope.js';
import { AUDIT_ONLY_NOTE, FOOTER_CTA } from './footer.js';
import { spendLine } from './spend.js';

// Re-exported so existing importers keep `core/output`'s single footer constant.
export { FOOTER_CTA } from './footer.js';

const SEVERITY_TAG = {
  error: '[fail]',
  warn: '[warn]',
  info: '[info]',
} as const;

/** Options common to text renderers. `color` off yields ANSI-free output. */
export interface TextRenderOptions {
  /** Force color on/off; defaults to picocolors' auto-detection. */
  color?: boolean;
  /** Path to the persisted snapshot, shown as the report location. */
  reportPath?: string;
}

function colors(opts: TextRenderOptions): ReturnType<typeof pc.createColors> {
  return pc.createColors(opts.color ?? pc.isColorSupported);
}

export function renderAuditText(
  report: AuditReport,
  opts: TextRenderOptions = {},
): string {
  const c = colors(opts);
  const lines: string[] = [];
  lines.push(c.bold(`AI Visibility Audit: ${report.domain}`));
  lines.push(`Score: ${report.score}/100`);
  lines.push('');

  lines.push('AI crawler access:');
  for (const bot of report.bots) {
    const mark =
      bot.access === 'allowed' ? c.green('ok     ') : c.red('BLOCKED');
    lines.push(`  ${mark}  ${bot.bot} (${bot.vendor})`);
  }
  lines.push('');

  if (report.findings.length > 0) {
    lines.push('Findings:');
    for (const f of report.findings) {
      lines.push(`  ${SEVERITY_TAG[f.severity]} ${f.message}`);
    }
    lines.push('');
  }

  // Audit-only honesty caveat, then the shared CTA (never merged - `check` uses
  // the same FOOTER_CTA but DOES query engines).
  lines.push(AUDIT_ONLY_NOTE);
  lines.push(FOOTER_CTA);
  return lines.join('\n');
}

/** Stable pretty JSON for `--json`. */
export function renderAuditJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

/** Stable pretty JSON of the check envelope for `--json` (no ANSI, the contract). */
export function renderCheckJson(env: VisibilityEnvelope): string {
  return JSON.stringify(env, null, 2);
}

/** The picocolors palette shape returned by `createColors`. */
export type Palette = ReturnType<typeof pc.createColors>;

/** Right-pad to a column width for aligned tables. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * The shared "Share of voice" block (brand marked `(you)`). Returns `[]` when
 * there are no rows, so `check` and `sources` render it identically.
 */
export function renderShareOfVoice(
  rows: ShareOfVoiceRow[],
  c: Palette,
): string[] {
  if (rows.length === 0) return [];
  const out = ['Share of voice:'];
  for (const row of rows) {
    const tag = row.isBrand ? c.bold(' (you)') : '';
    out.push(`  ${pad(row.name, 20)}${`${row.sharePct}`.padStart(5)}%${tag}`);
  }
  out.push('');
  return out;
}

/**
 * A titled `! note` block (honesty notes, diff caveats). Returns `[]` when there
 * are no notes, so every renderer presents caveats identically (rule #6).
 */
export function renderNoteBlock(
  title: string,
  notes: string[],
  c: Palette,
): string[] {
  if (notes.length === 0) return [];
  const out = [`${title}:`];
  for (const note of notes) out.push(`  ${c.yellow('!')} ${note}`);
  out.push('');
  return out;
}

/**
 * The shared "Run notes" block as a single string, for a caller that has notes
 * but no envelope to render (the `generate_buyer_queries` pack). Exists so an
 * entrypoint never hand-rolls the note formatting or reaches for picocolors
 * itself - the palette stays inside `core/output`. Empty notes render as "".
 */
export function renderRunNotes(
  notes: string[],
  opts: TextRenderOptions = {},
): string {
  return renderNoteBlock('Run notes', notes, colors(opts)).join('\n');
}

/** "1 prompt" / "3 prompts" - honest, grammatical count text. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The shared honest sampling line for both renderers. */
export function samplingLine(env: VisibilityEnvelope): string {
  const judged =
    env.sampling.judged > 0 ? `, ${env.sampling.judged} judged` : '';
  return `Based on ${plural(env.sampling.nPrompts, 'buyer prompt')} across ${plural(env.engines.length, 'engine')} (${plural(env.sampling.nAnswers, 'answer')}${judged}).`;
}

/**
 * The `check` landing output: headline AI Visibility Score, the honest sampling
 * caveat, per-engine lines (grounded vs parametric shown separately), share of
 * voice, notable findings, any honesty flags, and the report path. Consumes the
 * envelope only.
 */
export function renderCheckText(
  env: VisibilityEnvelope,
  opts: TextRenderOptions = {},
): string {
  const c = colors(opts);
  const lines: string[] = [];

  // A null score means nothing was measured. Say so - never print a number
  // (rule #6): "0/100" reads as "never recommended", which is a claim about the
  // brand that this run did not earn.
  lines.push(
    c.bold(
      env.score === null
        ? 'AI Visibility Score: not assessed'
        : `AI Visibility Score: ${env.score}/100`,
    ),
  );
  lines.push(`for ${env.profile.brand} (${env.domain})`);
  lines.push('');
  if (env.score === null) {
    // Only the "no score" explanation - the variance note ("This score is an
    // estimate ... will vary between runs") describes a score that does not
    // exist, so printing it here implies one was produced.
    lines.push(
      'No engine returned an answer, so there is no score for this run.',
    );
  } else {
    lines.push(env.sampling.varianceNote);
  }
  lines.push(samplingLine(env));
  lines.push('');

  lines.push('Per engine:');
  let widerCount = 0;
  for (const e of env.engines) {
    const score = `${e.score}`.padStart(3);
    // A grounded high-variance engine's score is a wider estimate (retrieval
    // rewriting). Mark it and explain below; framing only, not a score change.
    const wider = isWiderEstimate(e);
    if (wider) widerCount += 1;
    const marker = wider ? ` ${VARIANCE_MARKER}` : '';
    lines.push(
      `  ${pad(e.engine, 12)}${score}/100  ${pad(e.kind, 11)}mentioned ${e.mentions}/${e.answers}${marker}`,
    );
    // "grounded" is the mode that was requested; say when the engine did not
    // actually search on every answer (it earns less of the grounded weight).
    const retrieval = retrievalLine(e);
    if (retrieval) lines.push(`  ${' '.repeat(12)}${c.dim(retrieval)}`);
  }
  if (widerCount > 0) {
    lines.push(`  ${VARIANCE_MARKER} ${varianceNote(widerCount)}`);
  }
  lines.push('');

  lines.push(...renderShareOfVoice(env.shareOfVoice, c));

  // Reputation from branded prompts, shown apart from the score (it names the
  // brand, so it measures sentiment, not whether the AI surfaced you unprompted).
  if (env.reputation && env.reputation.answers > 0) {
    const r = env.reputation;
    lines.push('Reputation (you asked about the brand by name):');
    lines.push(
      `  ${plural(r.prompts, 'branded question')}: ${r.positive} positive, ${r.neutral} neutral, ${r.negative} negative`,
    );
    lines.push(
      '  Not part of the score above - branded prompts always mention you.',
    );
    lines.push('');
  }

  // Landing output shows warnings and misses, not info-level notes.
  const notable = env.findings.filter((f) => f.severity !== 'info');
  if (notable.length > 0) {
    lines.push('Findings:');
    for (const f of notable) {
      const tag =
        f.severity === 'error'
          ? c.red(SEVERITY_TAG.error)
          : c.yellow(SEVERITY_TAG.warn);
      lines.push(`  ${tag} ${f.message}`);
    }
    lines.push('');
  }

  lines.push(...renderNoteBlock('Run notes', honestyNotes(env), c));

  // What this run actually cost. Omitted entirely when not recorded, never
  // rendered as $0.0000 (rule #6).
  const cost = spendLine(env.spend);
  if (cost) {
    lines.push(c.dim(cost));
    lines.push('');
  }

  if (opts.reportPath) {
    lines.push(`Report: ${opts.reportPath}`);
    lines.push('');
  }

  lines.push(FOOTER_CTA);
  return lines.join('\n');
}

/**
 * The `sources` view: where AI engines drew their answers from (cited domains)
 * and the share-of-voice split, read from the latest saved snapshot. Consumes
 * the envelope only; honest about a partial run and about an empty citation set
 * (parametric-only runs cite nothing). Ends with the shared footer CTA.
 */
export function renderSourcesText(
  env: VisibilityEnvelope,
  opts: TextRenderOptions = {},
): string {
  const c = colors(opts);
  const lines: string[] = [];

  lines.push(c.bold(`Sources and share of voice: ${env.profile.brand}`));
  lines.push(`for ${env.domain}`);
  lines.push('');

  if (env.sources.length > 0) {
    lines.push('Cited sources (grounded answers):');
    for (const s of env.sources) {
      lines.push(`  ${pad(s.domain, 28)}${`${s.count}`.padStart(4)}`);
    }
  } else {
    lines.push('No cited sources: no grounded engine returned citations.');
  }
  lines.push('');

  lines.push(...renderShareOfVoice(env.shareOfVoice, c));
  lines.push(...renderNoteBlock('Run notes', honestyNotes(env), c));

  lines.push(FOOTER_CTA);
  return lines.join('\n');
}

/**
 * Human-readable honesty notes for a partial/degraded run (rule #6). Takes the
 * structural {@link PartialRunLike} so the check envelope and the shopping
 * envelope produce the SAME notes from the same flags.
 */
export function honestyNotes(env: PartialRunLike): string[] {
  if (!isPartialRun(env)) return [];
  const notes: string[] = [];
  if (env.costCapped) {
    // The cap can trip in the setup phase (discovery/query-gen) or the main
    // phase (asking), so do not claim specifically that prompts were skipped.
    notes.push(
      'Cost cap reached: the run stopped early to stay under budget, so results may be partial.',
    );
  }
  for (const s of env.skippedEngines ?? []) {
    notes.push(`Engine skipped: ${s.engine} (${s.reason}).`);
  }
  // State the real counts. "Partially answered" alone would hide HOW partial,
  // and the per-engine table shows a score without showing that it rests on a
  // thinner sample than the engines beside it.
  for (const p of env.partialEngines ?? []) {
    notes.push(
      `Engine answered ${p.answered} of ${p.attempted} prompts: ${p.engine} ` +
        `(${p.reason}). Its score rests on a smaller sample than the others.`,
    );
  }
  if (env.degraded) {
    notes.push('Profile was degraded (supplied via flags, not discovered).');
  }
  return notes;
}
