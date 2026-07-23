/**
 * Public API of the discovery module (M4). Import from `core/discovery`.
 *
 * Domain in, editable {@link BrandProfile} out: pure extraction of brand
 * signals, one guarded judge call for competitors, per-field provenance, and
 * `profile.json` persistence with a "user edits win" refresh.
 */
export { extractSignals, brandFromDomain } from './extract.js';
export type { ExtractedSignals } from './extract.js';
export {
  buildProfile,
  buildProfileFromFlags,
  mergeProfile,
} from './profile.js';
export type { BuildProfileInput, FlagProfileInput } from './profile.js';
export {
  discoverCompetitors,
  dropSelfReferences,
  parseCompetitors,
} from './competitors.js';
export type {
  CompetitorInput,
  CompetitorDeps,
  CompetitorResult,
} from './competitors.js';
export {
  loadProfile,
  saveProfile,
  profilePath,
  nodeProfileFs,
  ProfileParseError,
} from './persist.js';
export type { ProfileFs } from './persist.js';
export { discover } from './discover.js';
export type {
  DiscoverDeps,
  DiscoverOptions,
  DiscoverResult,
} from './discover.js';
