import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type EngineAnswer,
  type ScoreReport,
} from '../types.js';
import { scoreAnswers } from './scoring.js';

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../../test/fixtures/scoring/${name}`, import.meta.url),
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

describe('scoring golden report', () => {
  it('reproduces the checked-in report for the answer fixtures', async () => {
    const answers = fixture<EngineAnswer[]>('answers.json');
    const expected = fixture<ScoreReport>('golden-report.json');

    const report = await scoreAnswers(
      answers,
      PROFILE,
      {},
      {
        generatedAt: '2026-07-15T00:00:00.000Z',
      },
    );

    expect(report).toEqual(expected);
  });
});
