/**
 * Standalone "generate buyer queries for a domain" orchestrator (M15 needs it;
 * the CLI `queries` command is read-only). Composes discovery (M4) and query
 * generation (M5) - the front half of `runCheck` without the paid ask/score -
 * so this composition stays in `core/run` and entrypoints stay thin (rule #1).
 */
import { CostGuard } from '../costs.js';
import type { ProfileFs } from '../discovery/index.js';
import type { QueryFs } from '../queries/index.js';
import { createFetcher, type Fetcher } from '../fetcher/index.js';
import type { BrandProfile, JudgeClient, QueryPack } from '../types.js';
import { discoverAndBuildQueries } from './discover-queries.js';

export interface RunGenerateQueriesDeps {
  fetcher?: Fetcher;
  judge?: JudgeClient;
  guard?: CostGuard;
  profileFs?: ProfileFs;
  queryFs?: QueryFs;
  now?: () => string;
  persist?: boolean;
}

export interface RunGenerateQueriesOptions {
  stateDir: string;
  count?: number;
  refresh?: boolean;
}

export interface RunGenerateQueriesResult {
  pack: QueryPack;
  profile: BrandProfile;
  path?: string;
  notes: string[];
  costCapped?: boolean;
}

export async function runGenerateQueries(
  domain: string,
  deps: RunGenerateQueriesDeps,
  opts: RunGenerateQueriesOptions,
): Promise<RunGenerateQueriesResult> {
  const fetcher = deps.fetcher ?? createFetcher();
  const guard = deps.guard ?? new CostGuard();
  const now = deps.now ?? ((): string => new Date().toISOString());
  const persist = deps.persist ?? true;

  // Same discover -> resolveQueries composition `runCheck` uses. This command
  // always regenerates the pack (that is its whole job); it needs no progress
  // events, so the reporter is left at its no-op default.
  const front = await discoverAndBuildQueries(
    domain,
    {
      fetcher,
      judge: deps.judge,
      guard,
      profileFs: deps.profileFs,
      queryFs: deps.queryFs,
      now,
    },
    {
      stateDir: opts.stateDir,
      persist,
      refresh: opts.refresh,
      regenerate: true,
      count: opts.count,
    },
  );

  return {
    pack: front.pack,
    profile: front.profile,
    path: front.queryPath,
    notes: front.notes,
    costCapped: guard.costCapped ? true : undefined,
  };
}
