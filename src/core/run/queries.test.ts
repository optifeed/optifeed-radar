import { describe, it, expect } from 'vitest';
import { runGenerateQueries } from './queries.js';
import { createFetcher } from '../fetcher/index.js';
import type { ProfileFs } from '../discovery/index.js';
import type { QueryFs } from '../queries/index.js';
import type { JudgeClient } from '../types.js';

// In-memory fs fakes so the test touches NO real disk (hard rule #3). Reads
// reject with an ENOENT-coded error, which `loadProfile`/`loadQueryPack` read
// as "no cache yet" (they only swallow ENOENT; any other error rethrows) - so
// discovery/generation proceed to the judge exactly as the real not-found path
// does. Writes are no-ops for completeness; `persist: false` means they never
// run. Both interfaces (ProfileFs, QueryFs) require readFile/writeFile/mkdir.
function notFound(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOENT');
  err.code = 'ENOENT';
  return err;
}

function memoryFs(): ProfileFs & QueryFs {
  return {
    readFile: () => Promise.reject(notFound()),
    writeFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
  };
}

// A stub judge serving both judge calls `runGenerateQueries` makes:
// discovery's competitor call (M4, `discoverCompetitors`) and query
// generation (M5, `generateQueries`). Both go through the same `complete()`,
// so the stub branches on a marker unique to each real prompt (verified by
// reading `src/core/discovery/competitors.ts` and `src/core/queries/generate.ts`)
// rather than returning one fixed shape - a single shape that satisfies one
// parser's `extractBalanced` scan does not reliably satisfy the other's.
function stubJudge(): JudgeClient {
  return {
    model: 'stub-judge',
    async complete(prompt: string) {
      const isCompetitorCall = prompt.includes('competitor brand names');
      const text = isCompetitorCall
        ? JSON.stringify([])
        : JSON.stringify({
            'best-of': [
              'best acoustic pianos 2026',
              'digital piano for beginners',
              'where to buy a piano online',
            ],
            comparison: ['acoustic piano vs digital piano for a beginner'],
            problem: ['my piano keys feel too light, what should I look for'],
            trust: ['is Acme Piano a reputable brand'],
          });
      return { text, model: 'stub-judge', costUsd: 0 };
    },
  };
}

// A fetcher serving a minimal HTML page for the discovery fetch.
function fakeFetcher() {
  return createFetcher({
    fetchImpl: async () =>
      new Response(
        '<html><head><title>Acme Piano</title></head><body>Pianos</body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
        },
      ),
  });
}

describe('runGenerateQueries', () => {
  it('discovers a profile then generates a query pack', async () => {
    const result = await runGenerateQueries(
      'acme.example',
      {
        fetcher: fakeFetcher(),
        judge: stubJudge(),
        // In-memory fs (reads -> ENOENT) so the test touches no real disk;
        // persist off so writes never run either.
        profileFs: memoryFs(),
        queryFs: memoryFs(),
        persist: false,
      },
      { stateDir: '/tmp/does-not-matter', count: 3 },
    );
    expect(result.profile.domain).toBe('acme.example');
    expect(result.pack.queries.length).toBeGreaterThan(0);
    expect(result.pack.schema_version).toBeTruthy();
    expect(Array.isArray(result.notes)).toBe(true);
  });
});
