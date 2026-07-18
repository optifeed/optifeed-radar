# M15 - MCP server (design)

Date: 2026-07-18
Status: approved, ready for implementation plan
Module: M15 (launch #1 scope: M0-M11 + M15-M17)

## Goal

Expose the same core capabilities agent-natively over an MCP stdio server. The
tools are thin adapters in `src/mcp/` over the SAME `runCheck` / `runAudit`
seam the CLI (M11) uses. No pipeline or orchestration logic lives in `mcp/`
(hard rule #1); `core/` never imports `mcp/` (machine-checked by the
`no-restricted-imports` lint rule).

This module owns the FINAL, marketed MCP tool names (authoritative over the
dev-plan's tentative list).

## Scope

Launch #1 ships 4 tools. `compare_competitors` is DEFERRED to launch #2
alongside the CLI `compare` view (which M11 parked as "needs design"), and
`shopping_check` / `lint_feed` are launch #2 (M12/M14). Do not build them.

## Tools

All names are the marketed API. Descriptions are written FOR agents: each
includes a when-to-use line and a cost hint.

| Tool                     | Params                                      | Core call                         | Cost                       | Result                                              |
| ------------------------ | ------------------------------------------- | --------------------------------- | -------------------------- | --------------------------------------------------- |
| `check_visibility`       | `domain`, `engines?`, `quick?`, `max_cost?` | `runCheck` (`yes:true`)           | spends (guarded)           | JSON envelope + snapshot path                       |
| `audit_store`            | `domain`                                    | `runAudit`                        | zero-key, $0               | `AuditReport` JSON                                  |
| `generate_buyer_queries` | `domain`                                    | `resolveQueries` (regenerate)     | one judge call (setup cap) | query pack JSON + path                              |
| `get_snapshot_diff`      | `domain`                                    | `listSnapshots` + `diffEnvelopes` | $0                         | `SnapshotDiff` JSON, or honest note if <2 snapshots |

### Result payload (all tools)

The primary content block is the machine-readable JSON (the M8
`VisibilityEnvelope` via `renderCheckJson` for `check_visibility`; the analogous
JSON for the others), returned BOTH as a `text` content block and as MCP
`structuredContent`. A short note carries the on-disk artifact path (snapshot /
query pack) so the agent can reference it. No HTML report is written unless a
future param asks for it.

Every payload carries `schema_version` (rule #2) and all run-honesty flags -
`costCapped` / `skippedEngines` / `degraded`, and a null `score` when nothing
was measured (rule #6). The MCP layer never re-derives or re-scores; it renders
what core returns.

## Non-interactive semantics

MCP tools run without a human to confirm a spend estimate, so:

- Every spending tool passes `yes: true` to `runCheck` - the confirm gate is
  bypassed, not silently defaulted (hard rule #8; agents are first-class users).
- The judge model resolves non-interactively (cheapest available + notice); the
  notice is logged to stderr, never to the stdout MCP stream.
- `check_visibility` applies a DEFAULT cost cap of $0.50 via the `CostGuard`,
  overridable per-call by `max_cost` (raise or lower). `generate_buyer_queries`
  runs under the setup-phase budget. A cap hit returns a PARTIAL result flagged
  `costCapped` and NEVER throws (rule #5).
- `audit_store` and `get_snapshot_diff` spend nothing.

These semantics are documented in each tool's description string.

## Progress

`runCheck` already emits `ProgressEvent`s through its injected `onProgress`
callback. The MCP layer forwards them as MCP progress notifications when the
client supplied a `progressToken` on the call; when absent, `onProgress` is a
no-op. Progress goes to the MCP notification channel, never stdout content.

## Architecture: shared core deps factory

The concrete dependency construction (env -> engine adapters, judge-model
resolution, adapter-for-judge, node fs, guard) is currently inlined in
`cli/check.ts` `defaultCheckDeps`. MCP needs the same wiring but must not import
`cli/`. Extract the shared, entrypoint-agnostic part into `core/run`:

```
core/run/deps.ts
  buildCheckDeps({
    env, fetcher,
    engines?,        // narrow the adapter set; default ENGINE_ORDER
    judgeModel?,     // saved/override judge model
    guard?,          // caller supplies (cap policy differs: CLI flags vs MCP $0.50)
    now?,
  }): { deps, judgeNotice? }
```

- `deps` is a concrete `RunCheckDeps` MINUS `confirm` and `onProgress` - the two
  entrypoint-specific pieces. The caller attaches those.
- `judgeNotice` is the honest "using cheapest available judge" string; the
  caller decides where to surface it (both send it to stderr).
- The factory owns the judge-resolution dance once (resolve model -> find its
  engine -> build the judge adapter -> `createJudgeClient`), removing the
  drift risk of two call sites computing the same thing.

Consumers:

- `cli/check.ts` `defaultCheckDeps` shrinks to: call `buildCheckDeps`, write
  `judgeNotice` to `rt.err`, attach its TTY/inquirer confirm gate. Behavior is
  unchanged - M11's existing tests pin it.
- `mcp/deps.ts` calls `buildCheckDeps` with a guard defaulting to $0.50 (or the
  agent's `max_cost`), attaches no confirm (the tools pass `yes:true`).

`buildCheckDeps` lives in `core/`, imports only other `core/` modules, and is
consumed by both entrypoints - so `mcp/` never imports `cli/`.

## Layout

```
src/mcp/
  index.ts    # entrypoint: build server, connect StdioServerTransport, run
  server.ts   # createServer(deps-factory) -> registers the 4 tools; no process I/O (testable)
  tools.ts    # the 4 tool handlers, thin over core/run + core/output/renderers
  deps.ts     # non-interactive dep construction via core buildCheckDeps
```

`package.json` `bin` gains `optifeed-mcp -> dist/mcp/index.js`. The build
(`tsconfig.build.json`) already emits all of `src/`.

Testability: `createServer` takes injectable deps (a deps-builder + fetcher +
clock + fs) exactly like the CLI's `Runtime` seam, so the integration test
drives real MCP protocol frames over an in-memory transport pair with a mocked
fetcher and no network.

## Dependency

Add `@modelcontextprotocol/sdk` (stdio server + transport). CLAUDE.md
pre-authorizes this dependency for M15. No other new deps.

## Testing (acceptance)

1. MCP-over-stdio integration test: `initialize` -> `list_tools` (asserts the 4
   tool names + schemas) -> `call_tool audit_store` with a fixture domain via a
   mocked fetcher; assert the returned `AuditReport` JSON + `schema_version`.
   Zero network (rule #3).
2. Tool JSON-schema snapshot test: the 4 tools' input schemas are snapshotted;
   a change breaks the test (update-on-purpose, like the envelope snapshot).
3. Failure modes (minimum 2):
   - `check_visibility` with no engine key -> honest "no key" tool result,
     non-throwing (guides to `audit_store`).
   - `get_snapshot_diff` with <2 snapshots -> honest "not enough snapshots"
     note, not a fabricated diff.
   - (bonus) `check_visibility` with a `max_cost` low enough to trip the cap ->
     partial result flagged `costCapped`.
4. `buildCheckDeps` unit test: resolves the judge dance for a given env, honors
   `engines` narrowing, and M11's `defaultCheckDeps` tests still pass over the
   refactor.

## Out of scope (do not build)

- `compare_competitors`, `shopping_check`, `lint_feed` tools (launch #2).
- HTTP/SSE transport (stdio only for launch #1).
- Any new scoring, rendering, or pipeline logic - MCP renders what core returns.

## Module report checklist (for the PR)

- 4 tools registered; final names locked; descriptions agent-facing with cost
  hints.
- `buildCheckDeps` extracted to `core/run`; `cli` refactored to consume it with
  behavior unchanged; `mcp` consumes it non-interactively.
- Integration + schema-snapshot + >=2 failure-mode tests green; no network in
  tests.
- `bin` entry added; `npm run build` emits `dist/mcp/index.js`.
- Hard rules re-checked: #1 (mcp never imports cli; core never imports mcp),
  #2 (schema_version on every payload), #3 (no network in tests), #4 (no key in
  output), #5 (cap -> partial, never throws), #6 (honesty flags propagate),
  #8 (non-interactive, `yes:true`).
