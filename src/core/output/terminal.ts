/**
 * Plain-text terminal rendering (a seed of M9 renderers). No color deps yet;
 * consumes only the report shape (never re-derives). Honest footer, no em-dash.
 */
import type { AuditReport } from '../audit/index.js';

/** Single-source footer line (messaging guide: honest, no hype, no em-dash). */
export const FOOTER_CTA =
  'Static audit only - no AI engines were queried. More at optifeed.com';

const SEVERITY_TAG = {
  error: '[fail]',
  warn: '[warn]',
  info: '[info]',
} as const;

export function renderAuditText(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`AI Visibility Audit: ${report.domain}`);
  lines.push(`Score: ${report.score}/100`);
  lines.push('');

  lines.push('AI crawler access:');
  for (const bot of report.bots) {
    const mark = bot.access === 'allowed' ? 'ok     ' : 'BLOCKED';
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

  lines.push(FOOTER_CTA);
  return lines.join('\n');
}

/** Stable pretty JSON for `--json`. */
export function renderAuditJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
