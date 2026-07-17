/**
 * The query-resolution orchestrator (M5): decide which prompt pack a run uses.
 *
 * Precedence: an explicit `--queries <file>` wins; otherwise a persisted
 * `queries.yml` is reused as-is (hand edits survive) unless `--regenerate` is
 * set; only then do we make the one guarded judge call. All I/O is injected.
 */
import { CostGuard } from '../costs.js';
import type { BrandProfile, JudgeClient, QueryPack } from '../types.js';
import { generateQueries } from './generate.js';
import {
  loadQueryPack,
  loadQueryPackFromFile,
  nodeQueryFs,
  saveQueryPack,
  type QueryFs,
} from './persist.js';

export interface ResolveQueriesDeps {
  /** Judge for generation; omit only when a cached/explicit pack is expected. */
  judge?: JudgeClient;
  guard?: CostGuard;
  fs?: QueryFs;
  now?: () => string;
}

export interface ResolveQueriesOptions {
  /** Where `queries.yml` lives (from `resolveStateDir`). */
  stateDir: string;
  /** Regenerate even if a pack exists. */
  regenerate?: boolean;
  /** Explicit `--queries <file>` path; bypasses generation entirely. */
  queriesFile?: string;
  /** Target pack size. */
  count?: number;
  /** Persist a freshly generated pack (default true). */
  persist?: boolean;
}

export interface ResolveQueriesResult {
  pack: QueryPack;
  /** Path the pack was written to, if persisted this run. */
  path?: string;
  /** True when a persisted pack was reused without regenerating. */
  fromCache?: boolean;
  /** True when the pack came from an explicit `--queries` file. */
  fromFile?: boolean;
  /** Reason generation was skipped (cap hit, judge error, or no judge). */
  note?: string;
}

/**
 * Cap a REUSED pack (cached or explicit file) to `count`.
 *
 * `count` (`--quick`) is a cost control, so it must bind however the pack was
 * obtained - generation is not the only path that spends. Truncating rather
 * than regenerating is deliberate: it costs nothing, and keeping the first N in
 * file order means reruns ask the same prompts, so a `diff` stays meaningful.
 * Returns a note whenever prompts were dropped - never cap silently (rule #6).
 */
function capPack(
  pack: QueryPack,
  count: number | undefined,
  source: 'cache' | 'file',
): { pack: QueryPack; note?: string } {
  if (count === undefined || count <= 0 || pack.queries.length <= count) {
    return { pack };
  }
  const total = pack.queries.length;
  // The advice must match the path. On the cached path --regenerate produces a
  // fresh smaller pack; on the explicit --queries file path resolveQueries
  // returns before --regenerate is ever consulted, so pointing there would be a
  // dead instruction - and an input file is not a "saved" pack.
  const note =
    source === 'cache'
      ? `using ${count} of ${total} saved prompts (--quick); pass --regenerate for a fresh ${count}-prompt pack`
      : `using the first ${count} of ${total} prompts in the --queries file (--quick)`;
  return { pack: { ...pack, queries: pack.queries.slice(0, count) }, note };
}

/** Resolve the query pack for a run: explicit file, cached, or generated. */
export async function resolveQueries(
  profile: BrandProfile,
  deps: ResolveQueriesDeps,
  opts: ResolveQueriesOptions,
): Promise<ResolveQueriesResult> {
  const fs = deps.fs ?? nodeQueryFs();
  const now = deps.now ?? (() => new Date().toISOString());
  const guard = deps.guard ?? new CostGuard();
  const persist = opts.persist ?? true;

  // 1. Explicit --queries file wins outright (still bound by --quick).
  if (opts.queriesFile) {
    const loadedFile = await loadQueryPackFromFile(opts.queriesFile, fs);
    const { pack, note } = capPack(loadedFile, opts.count, 'file');
    return { pack, fromFile: true, ...(note ? { note } : {}) };
  }

  // 2. Reuse a persisted pack unless asked to regenerate (hand edits survive).
  // A shared state dir can hold another brand's pack - never ask one brand's
  // buyer prompts for a different domain; a mismatch regenerates.
  const loaded = await loadQueryPack(opts.stateDir, fs);
  const existing = loaded?.domain === profile.domain ? loaded : undefined;
  if (existing && !opts.regenerate) {
    const { pack, note } = capPack(existing, opts.count, 'cache');
    return { pack, fromCache: true, ...(note ? { note } : {}) };
  }

  // 3. Generate via one guarded judge call.
  if (!deps.judge) {
    return {
      pack: {
        schema_version: profile.schema_version,
        domain: profile.domain,
        queries: [],
        generatedAt: now(),
      },
      note: 'no judge configured',
    };
  }

  const { pack, skipped } = await generateQueries(
    profile,
    { judge: deps.judge, guard },
    { count: opts.count, generatedAt: now() },
  );

  // Only persist a pack that actually has queries - never clobber with an
  // empty pack from a capped or failed generation.
  const path =
    persist && pack.queries.length > 0
      ? await saveQueryPack(pack, opts.stateDir, fs)
      : undefined;

  return { pack, path, note: skipped };
}
