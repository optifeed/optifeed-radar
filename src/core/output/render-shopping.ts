/**
 * Rendering for a shopping run (M12a): terminal, JSON, and the HTML report.
 *
 * The ORDER here is a product decision, not a layout preference. The summary
 * leads every surface, in the order the ENVELOPE decided (`orderSkus`) - the
 * renderers never sort, so no two surfaces can disagree. Inside a product's
 * section, an ABSENT product leads with the shelf that beat it: "0 mentions"
 * is the least useful sentence we could write, while "engines recommended
 * Breville Bambino x6, Gaggia Classic x4" is the reason they ran this.
 *
 * Consumes the envelope only, never re-deriving from raw answers.
 */
import pc from 'picocolors';
import type {
  ShelfShareRow,
  ShoppingEnvelope,
  SkuReport,
} from '../shopping/index.js';
import { FOOTER_CTA } from './footer.js';
import { esc, REPORT_STYLE } from './html.js';
import { spendLine } from './spend.js';
import {
  honestyNotes,
  plural,
  renderNoteBlock,
  type Palette,
  type TextRenderOptions,
} from './terminal.js';

/** Shelf entries shown per product before the tail is summarized. */
const SHELF_SHOWN = 5;

function colors(opts: TextRenderOptions): Palette {
  return pc.createColors(opts.color ?? pc.isColorSupported);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * The one-line result for a product in the summary.
 *
 * Four outcomes, kept distinct on purpose: never asked and asked-but-unanswered
 * are an input problem and a RUN problem, and collapsing either into "not
 * recommended" accuses a product of losing a contest it never entered
 * (rule #6).
 */
export function summaryStatus(sku: SkuReport): string {
  if (sku.categoryPrompts === 0) return 'no category questions asked';
  if (sku.answers === 0) return 'category questions went unanswered';
  if (sku.mentions === 0) {
    return `not recommended in any of ${plural(sku.answers, 'answer')}`;
  }
  const rank =
    sku.avgPosition === null ? '' : `, average shelf rank ${sku.avgPosition}`;
  return `named in ${sku.mentions} of ${plural(sku.answers, 'answer')}${rank}`;
}

/** The score cell, or a dash when there is no score to show (never a 0). */
export function summaryScore(sku: SkuReport): string {
  return sku.answers === 0 ? '-' : `${sku.visibility ?? 0}/100`;
}

/**
 * Said once, under the summary: the products were asked DIFFERENT questions.
 * Without it the list reads as a head-to-head ranking, which it is not.
 */
export const SHOPPING_ORDER_NOTE =
  "Sorted by each product's own visibility. Products were asked different questions, so this compares how decisively each one wins its own shelf.";

/** The shelf as one honest line: who the engines named, and how often. */
export function shelfLine(shelf: ShelfShareRow[]): string {
  const shown = shelf.slice(0, SHELF_SHOWN);
  const parts = shown.map(
    (row) => `${row.name}${row.isYours ? ' (yours)' : ''} x${row.mentions}`,
  );
  const rest = shelf.length - shown.length;
  // Say what was left out rather than trimming silently.
  return rest > 0 ? `${parts.join(', ')}, and ${rest} more` : parts.join(', ');
}

/**
 * The headline block: every product, in the ONE order the envelope decided
 * (absent first, then by visibility). Renderers never re-sort.
 */
function summaryBlock(env: ShoppingEnvelope, c: Palette): string[] {
  const lines = [c.bold('Products by visibility:')];
  for (const sku of env.skus) {
    lines.push(
      `  ${pad(sku.product, 24)}${summaryScore(sku).padStart(7)}  ${summaryStatus(sku)}`,
    );
  }
  lines.push('');
  // A single product is not sorted against anything, so the note would confuse.
  if (env.skus.length > 1) {
    lines.push(c.dim(SHOPPING_ORDER_NOTE));
    lines.push('');
  }
  return lines;
}

/** One product's section. An absent product leads with its shelf. */
function productBlock(sku: SkuReport, c: Palette): string[] {
  const lines: string[] = [];
  const absent = sku.answers > 0 && sku.mentions === 0;
  lines.push(c.bold(absent ? `${sku.product} - not recommended` : sku.product));

  if (sku.categoryPrompts === 0) {
    // Never measured is not the same as never recommended, and must not render
    // as a 0 (rule #6).
    lines.push(
      '  No category questions were asked for this product: give it a descriptor to measure category visibility.',
    );
  } else if (sku.answers === 0) {
    // The questions existed; the run could not complete them (a cost cap, a
    // failed engine). Pointing at a descriptor here would blame the merchant
    // for the run's problem - the run notes carry the real cause.
    lines.push(
      `  Its ${plural(sku.categoryPrompts, 'category question')} went unanswered this run, so it has no visibility score. See the run notes below.`,
    );
  } else if (absent) {
    // Requirement 3: the shelf leads. This is the competitive intel a zero
    // cannot carry.
    lines.push(
      `  For these questions, engines recommended: ${shelfLine(sku.shelf)}`,
    );
    lines.push(
      `  Visibility: 0/100 - named in none of ${plural(sku.answers, 'answer')}.`,
    );
  } else {
    const rank =
      sku.avgPosition === null
        ? 'no ranked position'
        : `average shelf rank ${sku.avgPosition}`;
    lines.push(
      `  Visibility: ${sku.visibility ?? 0}/100 - named in ${sku.mentions} of ${plural(sku.answers, 'answer')}, ${rank}.`,
    );
    if (sku.shelf.length > 0) {
      lines.push(`  Shelf: ${shelfLine(sku.shelf)}`);
    }
  }

  for (const engine of sku.engines) {
    lines.push(
      `    ${pad(engine.engine, 12)}${`${engine.score}`.padStart(3)}/100  mentioned ${engine.mentions}/${engine.answers}`,
    );
  }

  const r = sku.reputation;
  if (r && r.answers > 0) {
    lines.push(
      `  Reputation (you asked about it by name): ${plural(r.answers, 'answer')}: ${r.positive} positive, ${r.neutral} neutral, ${r.negative} negative`,
    );
  }
  lines.push('');
  return lines;
}

/** The honest sampling line for a shopping run. */
export function shoppingSamplingLine(env: ShoppingEnvelope): string {
  const s = env.sampling;
  const judged = s.judged > 0 ? `, ${s.judged} judged` : '';
  return `Based on ${plural(s.nProducts, 'product')} x ${plural(s.nPrompts, 'shopper prompt')}: ${plural(s.nAnswers, 'engine answer')}${judged}.`;
}

/** The `shopping` terminal output. Ranking delta first, then each product. */
export function renderShoppingText(
  env: ShoppingEnvelope,
  opts: TextRenderOptions = {},
): string {
  const c = colors(opts);
  const lines: string[] = [];

  lines.push(c.bold(`Shopping visibility: ${env.profile.brand}`));
  lines.push(`${plural(env.skus.length, 'product')} checked for ${env.domain}`);
  lines.push('');
  lines.push(env.sampling.varianceNote);
  lines.push(shoppingSamplingLine(env));
  lines.push('');

  lines.push(...summaryBlock(env, c));
  for (const sku of env.skus) lines.push(...productBlock(sku, c));

  // Honesty flags first (they say how complete the run is), then what the run
  // reported about itself. Both come off the ENVELOPE, so the terminal and the
  // JSON say the same things.
  lines.push(
    ...renderNoteBlock('Run notes', [...honestyNotes(env), ...env.notes], c),
  );

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

/** Stable pretty JSON of the shopping envelope for `--json` (no ANSI). */
export function renderShoppingJson(env: ShoppingEnvelope): string {
  return JSON.stringify(env, null, 2);
}

function summaryTableHtml(skus: SkuReport[]): string {
  const body = skus
    .map(
      (sku) =>
        `<tr><td>${esc(sku.product)}</td><td>${esc(summaryScore(sku))}</td><td>${esc(summaryStatus(sku))}</td></tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th>Product</th><th>Visibility</th><th>Result</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function shelfHtml(shelf: ShelfShareRow[]): string {
  if (shelf.length === 0) return '';
  const rows = shelf
    .map(
      (row) =>
        `<tr><td>${esc(row.name)}${row.isYours ? ' <span class="muted">(yours)</span>' : ''}</td><td>${row.mentions}</td><td>${row.sharePct}%</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Recommended</th><th>Answers</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function productHtml(sku: SkuReport): string {
  const absent = sku.answers > 0 && sku.mentions === 0;
  const heading = esc(sku.product);

  let lead: string;
  if (sku.categoryPrompts === 0) {
    lead =
      '<p class="muted">No category questions were asked for this product: give it a descriptor to measure category visibility.</p>';
  } else if (sku.answers === 0) {
    lead = `<p class="muted">Its ${sku.categoryPrompts} category question${sku.categoryPrompts === 1 ? '' : 's'} went unanswered this run, so it has no visibility score. See the run notes.</p>`;
  } else if (absent) {
    // The shelf leads for an absent product, in the report as in the terminal.
    lead = `<p>Not recommended in any of the ${sku.answers} category answers. Engines recommended:</p>${shelfHtml(sku.shelf)}
      <p class="muted">Visibility: 0/100.</p>`;
  } else {
    lead = `<p>Visibility <strong>${sku.visibility ?? 0}/100</strong>, named in ${sku.mentions} of ${sku.answers} category answers${
      sku.avgPosition === null ? '' : `, average shelf rank ${sku.avgPosition}`
    }.</p>${shelfHtml(sku.shelf)}`;
  }

  const r = sku.reputation;
  const reputation =
    r && r.answers > 0
      ? `<p class="muted">Reputation from ${r.prompts} question${r.prompts === 1 ? '' : 's'} naming it: ${r.positive} positive, ${r.neutral} neutral, ${r.negative} negative. Sentiment only, not part of the visibility number.</p>`
      : '';

  return `<section><h2>${heading}</h2>${lead}${reputation}</section>`;
}

function evidenceHtml(env: ShoppingEnvelope): string {
  if (env.answers.length === 0) return '';
  const blocks = env.answers
    .map(
      (a) => `<details>
        <summary>${esc(a.engine)} (${a.kind}) &middot; ${esc(a.prompt)}</summary>
        <p class="answer">${esc(a.text)}</p>
      </details>`,
    )
    .join('');
  return `<section><h2>Evidence: raw answers</h2>${blocks}</section>`;
}

/** Render the full self-contained HTML report for a shopping run. */
export function renderShoppingHtml(env: ShoppingEnvelope): string {
  const date = env.generatedAt.slice(0, 10); // YYYY-MM-DD
  const notes = [...honestyNotes(env), ...env.notes];
  const notesHtml =
    notes.length > 0
      ? `<section><h2>Run notes</h2><ul class="notes">${notes
          .map((n) => `<li>${esc(n)}</li>`)
          .join('')}</ul></section>`
      : '';
  const cost = spendLine(env.spend);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shopping Visibility Report: ${esc(env.profile.brand)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Shopping Visibility Report</h1>
    <p class="muted">${esc(env.profile.brand)} &middot; ${esc(env.domain)} &middot; ${esc(date)}</p>
    <p class="muted">${esc(env.sampling.varianceNote)}</p>
    <p class="muted">${esc(shoppingSamplingLine(env))}</p>
  </header>

  <section><h2>Products by visibility</h2>${summaryTableHtml(env.skus)}
    ${env.skus.length > 1 ? `<p class="muted">${esc(SHOPPING_ORDER_NOTE)}</p>` : ''}
  </section>
  ${env.skus.map(productHtml).join('')}
  ${notesHtml}
  ${cost ? `<section><p class="muted">${esc(cost)}</p></section>` : ''}
  ${evidenceHtml(env)}

  <footer>${esc(FOOTER_CTA)}</footer>
</main>
</body>
</html>`;
}
