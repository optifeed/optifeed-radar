/**
 * Public API of the query-generation module (M5). Import from `core/queries`.
 *
 * Profile in, an editable/reusable buyer-prompt pack out: one guarded judge
 * call across intent types, a competitor-exclusion bias rule, and `queries.yml`
 * persistence that survives hand edits (regenerate only on `--regenerate`).
 */
export {
  activeIntents,
  buildQueryPack,
  excludeCompetitors,
  generateQueries,
  parseIntentQueries,
  DEFAULT_QUERY_COUNT,
  QUERY_INTENTS,
} from './generate.js';
export type {
  BuildPackInput,
  GenerateDeps,
  GenerateOptions,
  GenerateResult,
} from './generate.js';
export {
  loadQueryPack,
  loadQueryPackFromFile,
  saveQueryPack,
  parseQueryPack,
  queriesPath,
  toYaml,
  nodeQueryFs,
  QueryPackError,
} from './persist.js';
export type { QueryFs } from './persist.js';
export { resolveQueries } from './resolve.js';
export type {
  ResolveQueriesDeps,
  ResolveQueriesOptions,
  ResolveQueriesResult,
} from './resolve.js';
