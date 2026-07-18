/**
 * Public API of the run/orchestration module (M10). Import from `core/run`.
 *
 * The single seam every entrypoint (M11 CLI, M15 MCP) adapts over: `runCheck`
 * (full pipeline) and `runAudit` (zero-key audit path). No pipeline logic
 * lives in `cli/`/`mcp/` (hard rule #1).
 *
 * The entity source behind `runCheck` is deliberately generic (brand profile
 * today) so a later product-entity source can reuse this seam, but only the
 * brand path is built.
 */
export * from './audit.js';
export * from './check.js';
export * from './deps.js';
