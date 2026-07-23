/**
 * Public API of the run/orchestration module (M10). Import from `core/run`.
 *
 * The single seam every entrypoint (M11 CLI, M15 MCP) adapts over: `runCheck`
 * (full pipeline), `runAudit` (zero-key audit path), and `runShopping` (M12a,
 * the merchant's named products). No pipeline logic lives in `cli/`/`mcp/`
 * (hard rule #1).
 *
 * `runShopping` is the product-entity source the seam was left generic for: it
 * takes the products the merchant NAMED (there is no discovery) and reuses the
 * same discovery, ask, and scoring pieces one level down.
 */
export * from './audit.js';
export * from './check.js';
export * from './deps.js';
export * from './engine-selection.js';
export * from './queries.js';
export * from './shopping.js';
