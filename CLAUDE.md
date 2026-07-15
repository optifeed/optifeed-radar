# CLAUDE.md - Optifeed Visibility

Working conventions for developing this repo. Full scope and architecture live
in `optifeed-visibility-dev-plan.md` (the module plan, M0-M17) and `TASKS.md`
(status). Those files' "Global decisions / Hard rules" still govern; this file
adds workflow conventions and hard-won lessons.

## Workflow

- **TDD, always.** Write a failing test, watch it fail, minimal code to pass.
- **Gate before every commit:** `npm run check` (typecheck + lint + test) and
  `npm run format:check` must be green, and `npm run build` must emit. Do not
  pipe these through `| tail` when checking pass/fail - the pipe masks the exit
  code (a failing lint/test can look green).
- **Unit tests are fixture/mock only - no network** (hard rule #3). Inject
  `fetchImpl` / `httpPost` / clock / adapters; never hit the real network.
- Commit per module; end commit messages with the `Co-Authored-By` trailer.

## Architecture invariants (do not regress)

- `core/` never imports from `cli/` or `mcp/`. CLI/MCP are thin adapters over
  `core/run`. Orchestration logic in `cli/` is a bug (move it to `core/run`).
- Import from module roots (`core/audit`), not deep paths.
- Every JSON / persisted payload carries `schema_version`.
- Never log or persist API keys.
- `check` surfaces ONE headline score; the audit's own 0-100 shows only in the
  standalone `audit` command.

## Lessons from the M0-M6 code review (2026-07-15)

These failure modes passed green tests. Watch for them in every new module:

1. **Mocks must mirror real response shapes.** The "every real run costs $0"
   bug survived because adapter mocks omitted the `model` field that real
   providers echo (a _dated_ id like `gpt-4o-mini-2024-07-18`). A test that
   passes only because the mock left out a field the real source sends is a
   false negative. Give each provider/parser at least one fixture with the
   fields production actually returns.
2. **Look up by a key you control, not by external echoed values.** Cost is
   priced from the _configured_ model (guaranteed in `MODEL_PRICING`), never the
   provider-echoed id. Any table lookup on an external string needs a miss path.
3. **Enforcement APIs must be wired at the call site.** `CostGuard.authorize`
   existed but nothing called it, so `--max-cost` was silently unenforced.
   Money is spent only through the guard: `authorize` before, `record` after.
   Add a guard/limit method and a consumer that calls it in the same change.
4. **Parse every real data shape, not just the canonical one.** JSON-LD comes
   as objects, top-level arrays, and `@graph`. Web and LLM output is messy;
   handle the variants (this will bite M4 discovery, M5, M7 too).
5. **The graceful-failure contract covers ALL paths, including decode.** The
   fetcher and adapters must never throw raw - a 2xx with a non-JSON body must
   be wrapped too, not only network errors.
6. **Independent I/O runs concurrently.** Use `Promise.all` for independent
   fetches/calls; sequential `await` of unrelated requests is a latency bug.
7. **Do not fetch-and-discard.** If you fetch something, use it in the output,
   or do not fetch it.

## Cost & honesty (product-critical)

- Any LLM spend goes through the cost guard: estimate first, never spend
  silently. Two-phase budget (setup vs main). Hitting the cap NEVER throws -
  return a partial result flagged `costCapped`.
- Scores are estimates and say so; grounded vs parametric engines are reported
  separately; no fake precision. User-facing copy: no em-dashes (use "-"),
  "AI agents" not bare "agents".

## Review cadence

- Run a workflow-backed code review (high effort) at the end of each wave
  before building on top. The M0-M6 review found 10 real issues across 6
  modules; all fixed test-first (commit `d439065`).
