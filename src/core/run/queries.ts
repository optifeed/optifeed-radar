/**
 * Standalone "generate buyer queries for a domain" orchestrator (M15 needs it;
 * the CLI `queries` command is read-only). Composes discovery (M4) and query
 * generation (M5) - the front half of `runCheck` without the paid ask/score -
 * so this composition stays in `core/run` and entrypoints stay thin (rule #1).
 */
import { CostGuard } from '../costs.js';
import { discover, nodeProfileFs, type ProfileFs } from '../discovery/index.js';
import { resolveQueries, nodeQueryFs, type QueryFs } from '../queries/index.js';
import { createFetcher, type Fetcher } from '../fetcher/index.js';
import type { BrandProfile, JudgeClient, QueryPack } from '../types.js';

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
  const notes: string[] = [];

  const discovery = await discover(
    domain,
    {
      fetcher,
      judge: deps.judge,
      guard,
      fs: deps.profileFs ?? nodeProfileFs(),
      now,
    },
    { stateDir: opts.stateDir, refresh: opts.refresh, persist },
  );
  if (discovery.competitorNote) notes.push(discovery.competitorNote);

  const queries = await resolveQueries(
    discovery.profile,
    { judge: deps.judge, guard, fs: deps.queryFs ?? nodeQueryFs(), now },
    { stateDir: opts.stateDir, regenerate: true, count: opts.count, persist },
  );
  if (queries.note) notes.push(queries.note);

  return {
    pack: queries.pack,
    profile: discovery.profile,
    path: queries.path,
    notes,
    costCapped: guard.costCapped ? true : undefined,
  };
}
