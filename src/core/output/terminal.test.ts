import { describe, expect, it } from 'vitest';
import type { AuditReport } from '../audit/index.js';
import { AUDIT_ONLY_NOTE } from './footer.js';
import { FOOTER_CTA, renderAuditText } from './terminal.js';

const report: AuditReport = {
  schema_version: '0.1',
  domain: 'acme.example',
  score: 92,
  findings: [
    {
      id: 'robots.blocked.CCBot',
      severity: 'warn',
      message: 'CCBot is blocked in robots.txt.',
    },
    {
      id: 'meta.canonical',
      severity: 'info',
      message: 'Homepage has no canonical link.',
    },
  ],
  bots: [
    { bot: 'GPTBot', vendor: 'OpenAI', access: 'allowed', via: 'default' },
    {
      bot: 'CCBot',
      vendor: 'Common Crawl',
      access: 'blocked',
      via: 'specific',
    },
  ],
  categories: [
    { id: 'robots', label: 'AI crawler access', weight: 40, earned: 35 },
  ],
};

describe('renderAuditText', () => {
  it('renders the domain, score, bot access, findings and footer', () => {
    const out = renderAuditText(report);
    expect(out).toContain('acme.example');
    expect(out).toContain('92/100');
    expect(out).toContain('GPTBot');
    expect(out).toContain('CCBot is blocked in robots.txt.');
    expect(out).toContain(FOOTER_CTA);
  });

  it('never uses an em-dash (messaging guide)', () => {
    expect(renderAuditText(report)).not.toContain('—');
  });

  it('discloses that the audit queried no AI engines (rule #6)', () => {
    // Guards the caveat directly: the footer split moved it out of FOOTER_CTA,
    // so the audit-only honesty note needs its own assertion.
    expect(renderAuditText(report)).toContain(AUDIT_ONLY_NOTE);
  });
});
