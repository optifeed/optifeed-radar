import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type BrandProfile } from '../types.js';
import { VARIANCE_NOTE, type VisibilityEnvelope } from './envelope.js';
import { FOOTER_CTA } from './footer.js';
import { renderCheckText } from './terminal.js';
import { renderCheckHtml } from './html.js';

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: ['CafeRio'],
  competitors: ['Chipotle', 'Qdoba'],
};

function envelope(over: Partial<VisibilityEnvelope> = {}): VisibilityEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    generatedAt: '2026-07-15T00:00:00.000Z',
    domain: 'caferio.example',
    profile: PROFILE,
    score: 61,
    engines: [
      {
        engine: 'openai',
        kind: 'parametric',
        score: 92,
        mentionRate: 0.66,
        avgPosition: 1,
        answers: 3,
        mentions: 2,
      },
      {
        engine: 'perplexity',
        kind: 'grounded',
        score: 81,
        mentionRate: 0.5,
        avgPosition: 1,
        answers: 2,
        mentions: 1,
      },
    ],
    shareOfVoice: [
      { name: 'Café Rio', isBrand: true, mentions: 3, sharePct: 37.5 },
      { name: 'Chipotle', isBrand: false, mentions: 3, sharePct: 37.5 },
    ],
    sources: [{ domain: 'eater.com', count: 2 }],
    mentions: [],
    answers: [
      {
        engine: 'openai',
        kind: 'parametric',
        prompt: 'best fast-casual mexican?',
        text: 'Café Rio is a great choice.',
        model: 'gpt-4o',
        costUsd: 0,
        ts: '2026-07-15T00:00:00.000Z',
      },
    ],
    findings: [
      { id: 'robots-gptbot', severity: 'error', message: 'GPTBot is blocked' },
      { id: 'no-llms', severity: 'warn', message: 'No llms.txt found' },
      {
        id: 'has-product',
        severity: 'info',
        message: 'Product schema present',
      },
    ],
    sampling: {
      nPrompts: 5,
      nAnswers: 5,
      judged: 0,
      varianceNote: VARIANCE_NOTE,
    },
    ...over,
  };
}

describe('renderCheckText', () => {
  it('renders the headline score, brand, per-engine lines, and the footer', () => {
    const out = renderCheckText(envelope(), { color: false });
    expect(out).toContain('61/100');
    expect(out).toContain('Café Rio');
    expect(out).toContain('openai');
    expect(out).toContain('perplexity');
    // Grounded vs parametric are reported per engine (copy rule).
    expect(out).toContain('grounded');
    expect(out).toContain('parametric');
    expect(out).toContain(FOOTER_CTA);
  });

  it('emits no ANSI escape codes when color is off (clean for capture)', () => {
    const out = renderCheckText(envelope(), { color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });

  it('shows the honest sampling caveat', () => {
    const out = renderCheckText(envelope(), { color: false });
    expect(out).toContain(VARIANCE_NOTE);
    expect(out).toContain('5'); // nPrompts
  });

  it('shows warn/error findings but not info-level ones', () => {
    const out = renderCheckText(envelope(), { color: false });
    expect(out).toContain('No llms.txt found');
    expect(out).toContain('GPTBot is blocked');
    expect(out).not.toContain('Product schema present');
  });

  it('surfaces honesty flags (cost cap, skipped engines, degraded) - rule #6', () => {
    const out = renderCheckText(
      envelope({
        costCapped: true,
        degraded: true,
        skippedEngines: [{ engine: 'gemini', reason: 'no API key' }],
      }),
      { color: false },
    );
    expect(out.toLowerCase()).toContain('cap');
    expect(out).toContain('gemini');
    expect(out.toLowerCase()).toContain('degraded');
  });

  // A partially-answered engine is scored on fewer samples than its neighbours,
  // which the per-engine table does not make obvious on its own. The note has to
  // state the actual counts - "partial" without numbers is not honest about HOW
  // partial (rule #6, no vague hedging in place of the real figure).
  it('surfaces a partially-answered engine with its real sample counts', () => {
    const out = renderCheckText(
      envelope({
        partialEngines: [
          {
            engine: 'gemini',
            attempted: 8,
            answered: 1,
            reason: 'HTTP 429: quota exceeded',
          },
        ],
      }),
      { color: false },
    );
    // Assert the counts as a PHRASE. Bare `toContain('1')`/`toContain('8')`
    // matched digits already present elsewhere in the report (the 61/100 score,
    // per-engine scores, positions), so the test passed even when the note was
    // mutated to drop both numbers - the exact dishonest output this test
    // exists to prevent. A loose assertion is a false green (project lesson).
    expect(out).toContain('answered 1 of 8 prompts');
    expect(out).toContain('gemini');
    expect(out.toLowerCase()).toContain('quota exceeded');
  });

  it('reports reputation (branded prompts) apart from the score, honestly', () => {
    const out = renderCheckText(
      envelope({
        reputation: {
          prompts: 2,
          answers: 2,
          positive: 1,
          neutral: 1,
          negative: 0,
        },
      }),
      { color: false },
    );
    expect(out.toLowerCase()).toContain('reputation');
    // Sentiment breakdown is shown.
    expect(out).toContain('1 positive');
    expect(out).toContain('1 neutral');
    // The headline score is still the discovery number, unchanged.
    expect(out).toContain('61/100');
  });

  it('shows no reputation section when there are no branded prompts', () => {
    const out = renderCheckText(envelope(), { color: false });
    expect(out.toLowerCase()).not.toContain('reputation');
  });

  it('includes the report path when given', () => {
    const out = renderCheckText(envelope(), {
      color: false,
      reportPath: '/x/.optifeed/snapshots/2026.json',
    });
    expect(out).toContain('/x/.optifeed/snapshots/2026.json');
  });

  // M7 (Profound fanout study): engines differ in run-to-run retrieval variance
  // (ChatGPT ~91% unique queries vs Perplexity ~14%). This is surfaced as an
  // honest confidence qualifier - a high-variance engine's score is a wider
  // estimate - and must NEVER change the number (fake-precision copy rule).
  // The "rewrites your prompt before searching" claim is only true when the
  // engine actually ran GROUNDED, so the marker gates on the answer's kind.
  const groundedHiVar = {
    engine: 'openai' as const,
    kind: 'grounded' as const,
    score: 92,
    mentionRate: 0.66,
    avgPosition: 1,
    answers: 3,
    mentions: 2,
  };

  it('flags a grounded high-variance engine as a wider estimate without changing the score', () => {
    const out = renderCheckText(envelope({ engines: [groundedHiVar] }), {
      color: false,
    });
    expect(out).toMatch(/openai.*\*/);
    expect(out.toLowerCase()).toContain('run to run');
    expect(out.toLowerCase()).toContain('wider estimate');
    // The score itself is untouched by the framing.
    expect(out).toContain('92/100');
  });

  // Honesty (rule #6): a DEFAULT run answers openai parametrically - no web
  // search happened - so it must NOT be told the engine "rewrote your prompt
  // before searching". The marker keys on the run's actual mode, not engine id.
  it('does not flag a high-variance engine that ran parametrically', () => {
    const out = renderCheckText(
      envelope({
        engines: [{ ...groundedHiVar, kind: 'parametric' }],
      }),
      { color: false },
    );
    expect(out.toLowerCase()).not.toContain('run to run');
    expect(out).not.toMatch(/openai.*\*/);
  });

  it('omits the variance note when every engine is near-stable', () => {
    const out = renderCheckText(
      envelope({
        engines: [
          {
            engine: 'perplexity',
            kind: 'grounded',
            score: 81,
            mentionRate: 0.5,
            avgPosition: 1,
            answers: 2,
            mentions: 1,
          },
        ],
      }),
      { color: false },
    );
    // Perplexity is near-stable; no high-variance engine, so no marker or note.
    expect(out.toLowerCase()).not.toContain('run to run');
    expect(out).not.toMatch(/perplexity.*\*/);
  });

  it('uses singular copy when exactly one engine is high-variance', () => {
    const out = renderCheckText(envelope({ engines: [groundedHiVar] }), {
      color: false,
    });
    // One engine -> "this engine ... its score", not "these engines ... their".
    expect(out.toLowerCase()).toContain('this engine');
    expect(out.toLowerCase()).not.toContain('these engines');
  });

  it('never uses an em-dash', () => {
    expect(renderCheckText(envelope(), { color: false })).not.toContain('—');
  });

  // A tool that spends the user's money tells them what it spent, in the
  // report they actually read - not only in the JSON they would have to sum.
  it('reports what the run cost, with the setup/engine split', () => {
    const out = renderCheckText(
      envelope({
        spend: { setupUsd: 0.0021, mainUsd: 0.28, totalUsd: 0.2821 },
      }),
      { color: false },
    );
    expect(out).toContain('$0.2821');
    // The split matters: setup is spent before any engine is asked, so a user
    // who caps cost needs to see where the money went.
    expect(out).toContain('$0.0021');
    expect(out).toContain('$0.2800');
  });

  // Never fabricate $0.00 for a run whose cost was not recorded - the same
  // rule that renders an unmeasured score as "not assessed".
  it('says nothing about cost when the run carries no spend figure', () => {
    const out = renderCheckText(envelope(), { color: false });
    expect(out).not.toMatch(/\$0\.0000/);
    expect(out.toLowerCase()).not.toContain('run cost');
  });
});

describe('renderCheckHtml', () => {
  it('is fully self-contained: no external resource loads', () => {
    const html = renderCheckHtml(envelope());
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it('shows the agency header (brand + date), the score, and the footer', () => {
    const html = renderCheckHtml(envelope());
    expect(html).toContain('Café Rio');
    expect(html).toContain('2026-07-15');
    expect(html).toContain('61');
    expect(html).toContain(FOOTER_CTA);
  });

  it('embeds raw answers as evidence behind expandable sections', () => {
    const html = renderCheckHtml(envelope());
    expect(html).toMatch(/<details/i);
    expect(html).toContain('Café Rio is a great choice.');
  });

  // Renderer parity: an HTML report that omits the cost while the terminal
  // shows it is the same gap class as the variance note the HTML once missed.
  it('reports what the run cost', () => {
    const html = renderCheckHtml(
      envelope({
        spend: { setupUsd: 0.0021, mainUsd: 0.28, totalUsd: 0.2821 },
      }),
    );
    expect(html).toContain('$0.2821');
  });

  it('says nothing about cost when the run carries no spend figure', () => {
    const html = renderCheckHtml(envelope());
    expect(html.toLowerCase()).not.toContain('run cost');
  });

  it('HTML-escapes external text so answers cannot inject markup', () => {
    const html = renderCheckHtml(
      envelope({
        answers: [
          {
            engine: 'openai',
            kind: 'parametric',
            prompt: 'p',
            text: 'watch out <script>alert(1)</script>',
            model: 'gpt-4o',
            costUsd: 0,
            ts: '2026-07-15T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('surfaces honesty flags in the report', () => {
    const html = renderCheckHtml(
      envelope({
        costCapped: true,
        skippedEngines: [{ engine: 'gemini', reason: 'no API key' }],
      }),
    );
    expect(html.toLowerCase()).toContain('cap');
    expect(html).toContain('gemini');
  });

  it('renders a reputation section when branded prompts were asked', () => {
    const html = renderCheckHtml(
      envelope({
        reputation: {
          prompts: 2,
          answers: 2,
          positive: 1,
          neutral: 1,
          negative: 0,
        },
      }),
    );
    expect(html.toLowerCase()).toContain('reputation');
    expect(html).toContain('positive');
  });

  // The HTML report must carry the same retrieval-variance honesty as the
  // terminal (M8 lesson #2 / rule #6): a derived artifact must not relaunder a
  // wide estimate as an equally-confident number.
  it('marks a grounded high-variance engine as a wider estimate', () => {
    const html = renderCheckHtml(
      envelope({
        engines: [
          {
            engine: 'openai',
            kind: 'grounded',
            score: 92,
            mentionRate: 0.66,
            avgPosition: 1,
            answers: 3,
            mentions: 2,
          },
        ],
      }),
    );
    expect(html.toLowerCase()).toContain('run to run');
  });

  it('does not add the variance caveat for a parametric run', () => {
    const html = renderCheckHtml(envelope()); // openai parametric by default
    expect(html.toLowerCase()).not.toContain('run to run');
  });

  // M6 fanout capture is only useful if it reaches the output (lesson #7: use
  // what you fetch). A grounded answer that recorded the queries the engine
  // actually searched surfaces them in the evidence block; escaped, and omitted
  // when absent (never fabricated).
  it('surfaces captured fanout queries in the evidence section', () => {
    const html = renderCheckHtml(
      envelope({
        answers: [
          {
            engine: 'openai',
            kind: 'grounded',
            prompt: 'best fast-casual mexican?',
            text: 'Café Rio is a great choice.',
            citations: ['https://eater.com/a'],
            fanoutQueries: ['best fast casual mexican 2026'],
            model: 'gpt-5.3-chat-latest',
            costUsd: 0.01,
            ts: '2026-07-15T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(html).toContain('best fast casual mexican 2026');
  });

  it('shows no fanout line when an answer captured none', () => {
    const html = renderCheckHtml(envelope()); // default answer has no fanoutQueries
    expect(html.toLowerCase()).not.toContain('searched for');
  });

  it('never uses an em-dash', () => {
    expect(renderCheckHtml(envelope())).not.toContain('—');
  });
});

// The live 2026-07-17 failure a user would actually have seen: every engine
// failed, and the report still opened with a confident "AI Visibility Score:
// 0/100" over "0 buyer prompts ... (0 answers)". A reader cannot tell that from
// a brand that genuinely is never recommended. Both renderers must say the run
// was not assessed and must NOT print a number (rule #6).
describe('renderers over an unassessed run (score null)', () => {
  const unassessed = (over: Partial<VisibilityEnvelope> = {}) =>
    envelope({
      score: null,
      engines: [],
      answers: [],
      mentions: [],
      shareOfVoice: [],
      sources: [],
      sampling: { nPrompts: 0, nAnswers: 0, judged: 0, varianceNote: '' },
      degraded: true,
      ...over,
    });

  it('the terminal report says not assessed and never prints "0/100"', () => {
    const out = renderCheckText(unassessed(), { color: false });
    expect(out.toLowerCase()).toContain('not assessed');
    expect(out).not.toContain('0/100');
    expect(out).toContain(FOOTER_CTA);
  });

  it('does not print the variance note, which describes a score that does not exist', () => {
    // The note must be genuinely PRESENT on the envelope, else "not rendered"
    // is vacuous - buildEnvelope always sets VARIANCE_NOTE, so that is the real
    // input. (An empty-string fixture here would make this test pass for free.)
    const out = renderCheckText(
      unassessed({
        sampling: {
          nPrompts: 0,
          nAnswers: 0,
          judged: 0,
          varianceNote: VARIANCE_NOTE,
        },
      }),
      { color: false },
    );
    expect(VARIANCE_NOTE).toContain('estimate'); // guard: the note is non-empty
    expect(out).not.toContain(VARIANCE_NOTE);
  });

  it('the HTML report says not assessed and never prints a 0 score', () => {
    const html = renderCheckHtml(unassessed());
    expect(html.toLowerCase()).toContain('not assessed');
    expect(html).not.toContain('>0<');
  });

  it('the HTML report does not print the variance note under a null score', () => {
    // terminal.ts was fixed to suppress this; html.ts must match, or the
    // report claims a score exists right below "not assessed" (rule #6).
    const html = renderCheckHtml(
      unassessed({
        sampling: {
          nPrompts: 0,
          nAnswers: 0,
          judged: 0,
          varianceNote: VARIANCE_NOTE,
        },
      }),
    );
    expect(VARIANCE_NOTE).toContain('estimate');
    expect(html).not.toContain(VARIANCE_NOTE);
  });
});
