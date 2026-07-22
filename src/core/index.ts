/**
 * Public API of `core` (M1 surface).
 *
 * Other modules import from `core` (this barrel), not from deep paths
 * (hard rule #7). M1 exports the shared contracts, config resolution, and the
 * cost guard; later modules add their own barrels under `core/<module>`.
 */
export * from './types.js';
export * from './config.js';
export * from './costs.js';
export * from './validation.js';
export * from './version.js';
