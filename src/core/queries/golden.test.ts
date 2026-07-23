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

const RETAILER_PROFILE: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'do-re.example',
  brand: 'DoReShop',
  aliases: ['DoRe'],
  category: 'musical instrument shop',
  locale: 'tr',
  competitors: ['Zuhal Muzik'],
  businessType: 'retailer',
};

// One above each quota (the generator asks for quota + 1), and one prompt
// naming a rival shop so the golden proves the bias rule holds on this axis
// too. Every question asks WHERE to buy, never what to buy.
const RETAILER_ANSWER = JSON.stringify({
  'where-to-buy': [
    'Turkiye de piyano nereden alinir?',
    'Hangi magaza akustik gitar satiyor?',
    'Klavye almak icin en iyi muzik magazasi hangisi?',
    'Davul seti satan guvenilir bir magaza var mi?',
    'Zuhal Muzik disinda nereden calgi alabilirim?',
  ],
  comparison: [
    'Muzik aletini internetten mi magazadan mi almak daha iyi?',
    'Zincir magaza mi yerel muzik magazasi mi tercih edilmeli?',
  ],
  problem: [
    'Muzik aleti siparisim hasarli gelirse iade edebilir miyim?',
    'Piyano teslimati ve kurulumu nasil oluyor?',
  ],
  trust: [
    'DoReShop guvenilir bir muzik magazasi mi?',
    'DoReShop uzerinden taksitle alisveris guvenli mi?',
  ],
});

function retailerJudge(): JudgeClient {
  return {
    model: 'gpt-4o-mini',
    async complete() {
      return { text: RETAILER_ANSWER, costUsd: 0.0015, model: 'gpt-4o-mini' };
    },
  };
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

  // The retailer axis gets its own golden: where-to-buy leads, best-of never
  // appears, and the competitor-naming prompt is stripped here too.
  it('writes a retailer pack led by where-to-buy (golden)', async () => {
    const { fs, files } = memFs();

    const result = await resolveQueries(
      RETAILER_PROFILE,
      { judge: retailerJudge(), guard: new CostGuard(), fs, now: () => AT },
      { stateDir: '/state', count: 8 },
    );

    const intents = result.pack.queries.map((q) => q.intent);
    expect(intents).toContain('where-to-buy');
    expect(intents).not.toContain('best-of');
    expect(result.pack.queries.every((q) => !/Zuhal/i.test(q.prompt))).toBe(
      true,
    );
    expect(files.get(queriesPath('/state'))).toBe(
      golden('golden-retailer-pack.yml'),
    );
  });
});
