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

  it('never uses an em-dash', () => {
    expect(renderCheckText(envelope(), { color: false })).not.toContain('—');
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

  it('never uses an em-dash', () => {
    expect(renderCheckHtml(envelope())).not.toContain('—');
  });
});
