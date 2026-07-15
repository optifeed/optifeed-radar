import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '../core/run/index.js';
import { createProgressReporter } from './progress.js';

/** Feed a full run's events and return everything written (stderr). */
function drive(events: ProgressEvent[]): string {
  const chunks: string[] = [];
  const reporter = createProgressReporter({ write: (s) => chunks.push(s) });
  for (const e of events) reporter.onProgress(e);
  reporter.stop();
  return chunks.join('');
}

const FULL_RUN: ProgressEvent[] = [
  { kind: 'discovery-start' },
  { kind: 'discovery-done', brand: 'Acme' },
  { kind: 'queries-start' },
  { kind: 'queries-done', prompts: ['best widgets?', 'top makers?'] },
  { kind: 'ask-start', total: 2 },
  { kind: 'ask-answered', done: 1, total: 2 },
  { kind: 'ask-answered', done: 2, total: 2 },
  { kind: 'ask-done', answered: 2, total: 2 },
  { kind: 'scoring-start' },
  { kind: 'scoring-done' },
];

describe('createProgressReporter', () => {
  it('commits a checkmark line for each phase', () => {
    const out = drive(FULL_RUN);
    expect(out).toContain('✓ Discovered Acme');
    expect(out).toContain('✓ Generated 2 buyer prompts');
    expect(out).toContain('✓ Asked 2 prompts');
    expect(out).toContain('✓ Scored');
  });

  it('prints each buyer prompt, numbered', () => {
    const out = drive(FULL_RUN);
    expect(out).toContain('  1. best widgets?');
    expect(out).toContain('  2. top makers?');
  });

  it('uses singular grammar for a one-prompt run', () => {
    const out = drive([
      { kind: 'queries-done', prompts: ['only one?'] },
      { kind: 'ask-done', answered: 1, total: 1 },
    ]);
    expect(out).toContain('✓ Generated 1 buyer prompt');
    expect(out).toContain('✓ Asked 1 prompt');
    expect(out).not.toContain('prompts');
  });

  it('stop() leaves no spinner running (no throw, idempotent)', () => {
    const reporter = createProgressReporter({ write: () => {} });
    reporter.onProgress({ kind: 'discovery-start' });
    expect(() => {
      reporter.stop();
      reporter.stop();
    }).not.toThrow();
  });
});
