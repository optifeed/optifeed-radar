import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CostGuard } from '../costs.js';
import {
  SCHEMA_VERSION,
  type BrandProfile,
  type JudgeClient,
} from '../types.js';
import { queriesPath, type QueryFs } from './persist.js';
import { resolveQueries } from './resolve.js';

const AT = '2026-07-15T00:00:00.000Z';

function golden(name: string): string {
  return readFileSync(
    new URL(`../../../test/fixtures/queries/${name}`, import.meta.url),
    'utf8',
  );
}

const PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'acme.example',
  brand: 'Acme Rockets',
  aliases: ['Acme'],
  category: 'model rockets',
  offerings: ['Orbit Starter Kit'],
  locale: 'en-US',
  competitors: ['Estes', 'Quest'],
};

// A realistic judge answer: 2 per intent, one deliberately naming a competitor
// (must be stripped) so the golden proves the bias rule end to end.
const JUDGE_ANSWER = JSON.stringify({
  'best-of': [
    'What are the best model rocket kits for beginners?',
    'Which model rocket starter kits are most recommended?',
  ],
  comparison: [
    'What should I compare when choosing a model rocket kit?',
    'How does Estes stack up for beginners?',
  ],
  problem: [
    'Why does my model rocket engine keep misfiring?',
    'How do I stop a rocket kit from arcing on launch?',
  ],
  trust: [
    'Is Acme Rockets a reputable brand?',
    'Are Acme Rockets kits safe for kids?',
  ],
});

function judge(): JudgeClient {
  return {
    model: 'gpt-4o-mini',
    async complete() {
      return { text: JUDGE_ANSWER, costUsd: 0.0015, model: 'gpt-4o-mini' };
    },
  };
}

function memFs() {
  const files = new Map<string, string>();
  const fs: QueryFs = {
    async readFile(path) {
      const d = files.get(path);
      if (d === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return d;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async mkdir() {},
  };
  return { fs, files };
}

describe('queries golden file', () => {
  it('writes queries.yml matching the checked-in golden (format + bias rule)', async () => {
    const { fs, files } = memFs();

    const result = await resolveQueries(
      PROFILE,
      { judge: judge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 8 },
    );

    // The competitor-naming prompt ("How does Estes stack up...") is gone.
    expect(result.pack.queries.every((q) => !/\bEstes\b/i.test(q.prompt))).toBe(
      true,
    );
    expect(files.get(queriesPath('/state'))).toBe(golden('golden-pack.yml'));
  });
});
