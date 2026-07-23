# CLAUDE.md - Optifeed Radar

Open-source AI visibility checker: CLI + MCP server that asks real AI engines
(OpenAI, Gemini, Perplexity, Claude) real buyer questions and scores whether a
brand gets recommended. Runs locally, BYO API keys, MIT.

**Scope (revised 2026-07-18, revision 2): the launch build is M0-M11 + M12a +
M15-M17.** M12a (Shopping-lite: `shopping <domain> --products`, manually named
products only) is IN and shipped. Still DEFERRED: M12b (catalog/feed discovery
adapters), M13 (protocol spike), M14 (lint-feed). Do not implement, stub, or
scaffold M12b/M13/M14; M13/M14 were built and then removed on 2026-07-17
(recoverable at `faf351f`), do not reintroduce them. Copy rule that follows
from this: the products a user NAMES are present tense; catalog/feed discovery
and ACP/UCP feed linting stay FUTURE tense with a waitlist link (enforced by
`test/copy/messaging-rules.ts`).

**The module plan is authoritative and lives in the docs repo:
`/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md`** (modules M0-M17 +
the Global decisions section - read it before writing any code; it carries the
same scope revision). If that path is not accessible in your session, ask
before proceeding - do not guess module scope. `TASKS.md` tracks status only.
Implement one module per session unless told otherwise. Where this file and
the plan disagree, the plan wins. Fuller product strategy and the messaging
guide live in `/Users/erdem/workspace/optifeed-radar-docs/source-of-truth.html`.

## Commands

```bash
npm run check           # typecheck + lint + test - the pre-commit gate
npm run typecheck       # tsc --noEmit
npm test                # vitest run
npm test -- <pattern>   # a single test file
npm run format:check    # prettier --check (also part of the gate)
npm run build           # tsc -p tsconfig.build.json -> dist/
npm run dev -- <args>   # tsx src/cli/index.ts <args>  (e.g. audit example.com)
```

## Stack

TypeScript strict, Node >= 20, ESM only (NodeNext). Build via `tsc` (not tsup).
Installed: commander (CLI), cheerio (HTML), vitest, tsx, ESLint (type-aware) +
Prettier. Arriving with their owning module - do not add early: yaml (M5),
picocolors (M9), @inquirer/prompts (M11), @modelcontextprotocol/sdk / stdio
(M15). **No new dependencies without justifying them in the PR.**

## Layout

`src/core/` (all logic) · `src/cli/` (thin commander adapters) · `src/mcp/`
(thin MCP adapters) · both entrypoints call `core/run/` (the orchestrator).
`skills/`, `.claude-plugin/` are agent surfaces. Fixtures in
`test/fixtures/<module>/`.

## Hard rules (violations = rejected PR)

1. `core/` never imports from `cli/` or `mcp/`. Run logic lives in `core/run/`,
   not in entrypoints. (Machine-checked: a `no-restricted-imports` lint rule
   fails the build if `core/**` imports `cli/`/`mcp/`.)
2. Every JSON output / persisted file carries `schema_version` ("0.1").
   Breaking a serialized format = bump it + update the schema snapshot test.
3. No network calls in unit tests. Fixtures only. Inject `fetchImpl` /
   `httpPost` / clock / fs / adapters; never hit the real network.
4. Never log or persist API keys.
5. Anything that spends LLM money goes through the cost guard (`core/costs.ts`).
   Estimate before spending; respect `--max-cost`. Two-phase budget (setup vs
   main). Hitting the cap NEVER throws - return a partial flagged `costCapped`.
6. Honest output: scores are estimates from sampling and say so. Partial runs
   surface `skippedEngines`/`costCapped`/`degraded` - never hide them. One
   headline score: only M7's AI Visibility Score is THE number; the audit score
   (M3) never competes with it inside `check` (it appears there as findings).
7. Import modules only from their roots (`core/audit`, never
   `core/audit/robots`).
8. Interactive prompts must always be bypassable (`--yes` + flags). Agents are
   first-class users of this CLI.

## Workflow

- **TDD, always.** Write the failing test first, watch it fail for the right
  reason, minimal code to pass. The plan's acceptance criteria are the test
  list; a module without failure-mode tests (minimum 2) is not done.
- **Gate before every commit:** `npm run check` and `npm run format:check` must
  be green, and `npm run build` must emit. Do not pipe these through `| tail`
  when checking pass/fail - the pipe masks the exit code (a failing lint/test
  can look green).
- **Verify before claiming done:** typecheck + full vitest + run the actual
  command/flow against a fixture (or `npm run dev -- <cmd>`). Evidence, not
  assertions.
- Commit per logical change (per module for feature work); end commit messages
  with the `Co-Authored-By` trailer. The PR description ends with a
  `## Module report`: what was built, deviations from the plan, anything the
  next module needs.
- Stay in your module. `types.ts` additions are allowed but must be
  backward-compatible; touching another module's internals is not.

## Copy rules (README, help text, error messages, report footers)

Brand is "Optifeed" (never "OptiFeed"). No em-dashes (use "-"). "AI agents" not
bare "agents". No invented metrics or fake precision. No "paid tools for free"
framing. Roadmap features in future tense; only present-true, verified
capability in present tense. Grounded vs parametric engines reported
separately. Every human-readable report ends with the single footer CTA
constant - defined once in `core/output`.

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
   handle the variants (this bit M4 discovery; it will bite M5, M7 too).
5. **The graceful-failure contract covers ALL paths, including decode.** The
   fetcher and adapters must never throw raw - a 2xx with a non-JSON body must
   be wrapped too, not only network errors.
6. **Independent I/O runs concurrently.** Use `Promise.all` for independent
   fetches/calls; sequential `await` of unrelated requests is a latency bug.
7. **Do not fetch-and-discard.** If you fetch something, use it in the output,
   or do not fetch it.

## Lessons from the M8 code review (2026-07-15)

Honesty (hard rule #6) and validation (hard rule #2) are where green tests lie
the most. Watch these in every module that scores, persists, or compares:

1. **"Partial" is multi-signal - centralize the predicate, check every flag.**
   `RunHonesty` carries three _independent_ optionals (`costCapped`,
   `skippedEngines`, `degraded`); "is this run partial?" must consider all
   three from one shared function (`isPartialRun`), never a hand-rolled subset
   at each call site. `failUnder`/`diff` checked only two, so a one-engine run
   read as full-confidence.
2. **Honesty must propagate to every derived artifact, and "inputs changed"
   guards must be symmetric.** If an envelope is partial, everything computed
   from it (diffs, exit codes, renders) says so - a derived artifact that drops
   the flags relaunders a partial run as complete. And if you flag one changed
   dimension (`promptSetChanged`), flag every changeable dimension
   (`engineSetChanged`) - an unguarded axis hides a whole engine leaving.
3. **`schema_version` validation checks the VALUE; a validator vouches for
   EVERY field a consumer dereferences.** Type-checking the field to be a
   string is not rule #2 - comparing it to the supported version is (else the
   guard never fires at load). A loader that validates 6 of 12 fields gives
   false confidence: the first missing field crashes a downstream consumer that
   trusted the loader. (Three loaders - `loadProfile`, `parseQueryPack`,
   `loadSnapshot` - now hand-roll the same checks; a shared `core` validation
   helper is the standing follow-up.)
4. **A function comparing two persisted artifacts must verify they are
   comparable.** Snapshots share one directory and are keyed only by time; two
   files are not guaranteed to be the same subject. `diff` throws on a
   domain mismatch rather than silently comparing two brands.

## Review cadence

- Run a workflow-backed code review (high effort) at the end of each wave
  before building on top. The M0-M6 review found 10 real issues across 6
  modules; all fixed test-first (commit `d439065`).
