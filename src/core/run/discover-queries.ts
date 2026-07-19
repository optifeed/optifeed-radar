/**
 * The shared front half of a run: discover the brand profile (M4) then resolve
 * the buyer query pack (M5). Both `runCheck` (which runs it concurrently with
 * the zero-LLM audit, then asks/scores) and `runGenerateQueries` (which stops
 * here) compose the same two calls, so it lives in exactly one place - a change
 * to discovery/query-gen wiring can never make the two surfaces drift (M15
 * review). It emits the discovery/queries {@link ProgressEvent}s itself so the
 * caller only owns the terminal `discovery-start` and the ask/scoring phases.
 */
import { CostGuard } from '../costs.js';
import { discover, nodeProfileFs, type ProfileFs } from '../discovery/index.js';
import { resolveQueries, nodeQueryFs, type QueryFs } from '../queries/index.js';
import type { Fetcher } from '../fetcher/index.js';
import type { BrandProfile, JudgeClient, QueryPack } from '../types.js';
import type { ProgressEvent } from './check.js';

export interface DiscoverAndQueriesDeps {
  fetcher: Fetcher;
  judge?: JudgeClient;
  guard: CostGuard;
  profileFs?: ProfileFs;
  queryFs?: QueryFs;
  now: () => string;
}

export interface DiscoverAndQueriesOptions {
  stateDir: string;
  persist: boolean;
  // discovery
  refresh?: boolean;
  brand?: string;
  category?: string;
  samplePages?: number;
  // queries
  regenerate?: boolean;
  queriesFile?: string;
  count?: number;
}

export interface DiscoverAndQueriesResult {
  profile: BrandProfile;
  pack: QueryPack;
  /** Path the query pack was written to, if persisted. */
  queryPath?: string;
  /** Human-readable notes (competitor skip, query-gen skip). */
  notes: string[];
}

export async function discoverAndBuildQueries(
  domain: string,
  deps: DiscoverAndQueriesDeps,
  opts: DiscoverAndQueriesOptions,
  report: (event: ProgressEvent) => void = (): void => undefined,
): Promise<DiscoverAndQueriesResult> {
  const notes: string[] = [];

  const discovery = await discover(
    domain,
    {
      fetcher: deps.fetcher,
      judge: deps.judge,
      guard: deps.guard,
      fs: deps.profileFs ?? nodeProfileFs(),
      now: deps.now,
    },
    {
      stateDir: opts.stateDir,
      refresh: opts.refresh,
      brand: opts.brand,
      category: opts.category,
      samplePages: opts.samplePages,
      persist: opts.persist,
    },
  );
  const profile = discovery.profile;
  report({ kind: 'discovery-done', brand: profile.brand });
  if (discovery.competitorNote) notes.push(discovery.competitorNote);

  report({ kind: 'queries-start' });
  const queries = await resolveQueries(
    profile,
    {
      judge: deps.judge,
      guard: deps.guard,
      fs: deps.queryFs ?? nodeQueryFs(),
      now: deps.now,
    },
    {
      stateDir: opts.stateDir,
      regenerate: opts.regenerate,
      queriesFile: opts.queriesFile,
      count: opts.count,
      persist: opts.persist,
    },
  );
  if (queries.note) notes.push(queries.note);
  report({
    kind: 'queries-done',
    prompts: queries.pack.queries.map((q) => q.prompt),
  });

  return { profile, pack: queries.pack, queryPath: queries.path, notes };
}
