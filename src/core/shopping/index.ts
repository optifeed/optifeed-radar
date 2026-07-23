/**
 * Public API of the shopping module (M12a). Import from `core/shopping`.
 *
 * Shopping-lite: the merchant NAMES their products (there is no discovery of
 * any kind) and the run checks each one two ways - category buying prompts
 * (does it get recommended?) and product-named prompts (what do engines say
 * about it?). Its headline is the delta between the merchant's own ranking, as
 * given by the input order, and the ranking the engines actually show; when a
 * product is absent, the shelf that beat it leads instead of a bare zero.
 */
export {
  MAX_PRODUCTS,
  ProductListError,
  parseProductsFile,
  parseProductsFlag,
  resolveProducts,
} from './products.js';
export type { ResolvedProducts } from './products.js';

export {
  PROMPTS_PER_PRODUCT,
  REPUTATION_PROMPTS_PER_PRODUCT,
  VISIBILITY_PROMPTS_PER_PRODUCT,
  generateProductQueries,
  parseProductQueries,
} from './queries.js';
export type {
  ProductLayer,
  ProductPrompt,
  ProductQueriesDeps,
  ProductQueriesOptions,
  ProductQueriesResult,
} from './queries.js';

export {
  analyzeProductAnswer,
  extractRecommendations,
  productTerms,
  shelfEntryIsProduct,
} from './detect.js';
export type { ProductMention } from './detect.js';

export {
  SHOPPING_JUDGE_RATE_CAP,
  parseProductVerdict,
  refineProductMentions,
} from './judge.js';
export type {
  ProductVerdict,
  RefineProductsDeps,
  RefineProductsOptions,
  RefineProductsResult,
} from './judge.js';

export { scoreProduct, shelfShareOfVoice } from './score.js';
export type {
  AnalyzedAnswer,
  ScoreProductInput,
  ShelfShareRow,
  SkuReport,
} from './score.js';

export { computeRankingDelta } from './ranking.js';
export type { RankingDeltaRow } from './ranking.js';

export { SHOPPING_VARIANCE_NOTE, buildShoppingEnvelope } from './envelope.js';
export type {
  BuildShoppingEnvelopeInput,
  ShoppingEnvelope,
  ShoppingSampling,
} from './envelope.js';

export {
  ShoppingRunParseError,
  listShoppingRuns,
  loadShoppingRun,
  nodeShoppingFs,
  saveShoppingRun,
  shoppingDir,
  shoppingFileName,
} from './persist.js';
export type { ShoppingFs } from './persist.js';
