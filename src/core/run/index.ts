/**
 * Public API of the run/orchestration module (M10). Import from `core/run`.
 *
 * The single seam every entrypoint (M11 CLI, M15 MCP, M12 shopping) adapts
 * over: `runCheck` (full pipeline) and `runAudit` (zero-key audit path). No
 * pipeline logic lives in `cli/`/`mcp/` (hard rule #1).
 */
export * from './audit.js';
export * from './check.js';
