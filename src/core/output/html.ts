/**
 * Self-contained HTML report over the M8 envelope (M9). One file, no external
 * requests (inline CSS, no scripts, no remote assets), dark theme, agency-
 * friendly header (brand + date). Raw answers are embedded as evidence behind
 * expandable `<details>` sections. All external text (brand, answers, findings,
 * citations) is HTML-escaped - LLM/web output is untrusted and must not inject
 * markup. Template is TS string literals; no templating dependency. Consumes
 * the envelope only.
 */
import type { EngineAnswer, EngineScore, Finding } from '../types.js';
import type { VisibilityEnvelope } from './envelope.js';
import { FOOTER_CTA } from './footer.js';
import { honestyNotes, samplingLine } from './terminal.js';

/** Escape the five HTML-significant characters so untrusted text is inert. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem;
    background: #0f1115; color: #e6e8eb;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  header { border-bottom: 1px solid #2a2e37; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .muted { color: #9aa1ab; }
  .score { font-size: 3rem; font-weight: 700; line-height: 1; margin: .25rem 0; }
  .score span { font-size: 1rem; font-weight: 400; color: #9aa1ab; }
  section { margin: 1.5rem 0; }
  h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .04em; color: #9aa1ab; margin: 0 0 .6rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #20242c; }
  th { color: #9aa1ab; font-weight: 500; }
  .tag { display: inline-block; padding: 0 .4rem; border-radius: 3px; font-size: .8rem; }
  .tag.error { background: #3a1d1d; color: #ff9b9b; }
  .tag.warn { background: #3a331d; color: #ffe08a; }
  .tag.info { background: #1d2a3a; color: #9bc7ff; }
  .notes li { color: #ffe08a; }
  details { border: 1px solid #2a2e37; border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
  summary { cursor: pointer; }
  .answer { white-space: pre-wrap; color: #cfd3da; margin: .5rem 0 0; }
  footer { border-top: 1px solid #2a2e37; margin-top: 2rem; padding-top: 1rem; color: #9aa1ab; }
`;

function enginesTable(engines: EngineScore[]): string {
  const rows = engines
    .map(
      (e) => `<tr>
        <td>${esc(e.engine)}</td>
        <td>${e.kind}</td>
        <td>${e.score}/100</td>
        <td>${e.mentions}/${e.answers}</td>
      </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th>Engine</th><th>Type</th><th>Score</th><th>Mentioned</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function findingsList(findings: Finding[]): string {
  const notable = findings.filter((f) => f.severity !== 'info');
  if (notable.length === 0) return '';
  const items = notable
    .map(
      (f) =>
        `<tr><td><span class="tag ${f.severity}">${f.severity}</span></td><td>${esc(f.message)}</td></tr>`,
    )
    .join('');
  return `<section><h2>Findings</h2><table><tbody>${items}</tbody></table></section>`;
}

function evidence(answers: EngineAnswer[]): string {
  if (answers.length === 0) return '';
  const blocks = answers
    .map((a) => {
      const cites =
        a.citations && a.citations.length > 0
          ? `<p class="muted">Cited: ${a.citations.map(esc).join(', ')}</p>`
          : '';
      return `<details>
        <summary>${esc(a.engine)} (${a.kind}) &middot; ${esc(a.prompt)}</summary>
        <p class="answer">${esc(a.text)}</p>
        ${cites}
      </details>`;
    })
    .join('');
  return `<section><h2>Evidence: raw answers</h2>${blocks}</section>`;
}

function reputationSection(env: VisibilityEnvelope): string {
  const r = env.reputation;
  if (!r || r.answers === 0) return '';
  return `<section><h2>Reputation</h2>
    <p class="muted">From ${r.prompts} branded question${r.prompts === 1 ? '' : 's'} that named the brand. Sentiment only - not part of the score above, since naming the brand always yields a mention.</p>
    <table><tbody>
      <tr><td>positive</td><td>${r.positive}</td></tr>
      <tr><td>neutral</td><td>${r.neutral}</td></tr>
      <tr><td>negative</td><td>${r.negative}</td></tr>
    </tbody></table>
  </section>`;
}

function notesSection(env: VisibilityEnvelope): string {
  const notes = honestyNotes(env);
  if (notes.length === 0) return '';
  const items = notes.map((n) => `<li>${esc(n)}</li>`).join('');
  return `<section><h2>Run notes</h2><ul class="notes">${items}</ul></section>`;
}

function shareOfVoice(env: VisibilityEnvelope): string {
  if (env.shareOfVoice.length === 0) return '';
  const rows = env.shareOfVoice
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}${r.isBrand ? ' <span class="muted">(you)</span>' : ''}</td><td>${r.sharePct}%</td></tr>`,
    )
    .join('');
  return `<section><h2>Share of voice</h2><table><tbody>${rows}</tbody></table></section>`;
}

/** Render the full self-contained HTML report for a check envelope. */
export function renderCheckHtml(env: VisibilityEnvelope): string {
  const date = env.generatedAt.slice(0, 10); // YYYY-MM-DD
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Visibility Report: ${esc(env.profile.brand)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>AI Visibility Report</h1>
    <p class="muted">${esc(env.profile.brand)} &middot; ${esc(env.domain)} &middot; ${esc(date)}</p>
    <div class="score">${
      env.score === null
        ? '<span>not assessed - no engine returned an answer</span>'
        : `${env.score}<span>/100</span>`
    }</div>
    <p class="muted">${esc(env.sampling.varianceNote)}</p>
    <p class="muted">${esc(samplingLine(env))}</p>
  </header>

  <section><h2>Per engine</h2>${enginesTable(env.engines)}</section>
  ${shareOfVoice(env)}
  ${reputationSection(env)}
  ${findingsList(env.findings)}
  ${notesSection(env)}
  ${evidence(env.answers)}

  <footer>${esc(FOOTER_CTA)}</footer>
</main>
</body>
</html>`;
}
