import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type Finding,
} from '../types.js';
import { scoreAnswers } from '../scoring/index.js';
import { buildEnvelope, type VisibilityEnvelope } from './envelope.js';

function fixture<T>(dir: string, name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../../test/fixtures/${dir}/${name}`, import.meta.url),
      'utf8',
    ),
  ) as T;
}

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'caferio.example',
  brand: 'Café Rio',
  aliases: ['CafeRio'],
  competitors: ['Chipotle', 'Qdoba'],
};

const AUDIT_FINDINGS: Finding[] = [
  {
    id: 'robots-gptbot-blocked',
    severity: 'error',
    message: 'GPTBot is blocked in robots.txt',
    affectedEngines: ['openai'],
  },
  {
    id: 'no-llms-txt',
    severity: 'warn',
    message: 'No llms.txt found',
  },
];

/**
 * The JSON schema snapshot: this is the stable public shape of a `check` run.
 * A breaking change to the envelope makes this fail, which forces a
 * `schema_version` bump + a fresh golden (hard rule #2).
 */
describe('envelope schema snapshot', () => {
  it('reproduces the checked-in golden envelope', async () => {
    const answers = fixture<EngineAnswer[]>('scoring', 'answers.json');
    const score = await scoreAnswers(
      answers,
      PROFILE,
      {},
      { generatedAt: '2026-07-15T00:00:00.000Z' },
    );

    const env = buildEnvelope({
      profile: PROFILE,
      score,
      answers,
      auditFindings: AUDIT_FINDINGS,
      generatedAt: '2026-07-15T00:00:00.000Z',
    });

    const expected = fixture<VisibilityEnvelope>(
      'output',
      'golden-envelope.json',
    );
    expect(env).toEqual(expected);
  });

  it('pins the schema version so a break forces a bump', () => {
    const expected = fixture<VisibilityEnvelope>(
      'output',
      'golden-envelope.json',
    );
    expect(expected.schema_version).toBe('0.1');
  });
});
