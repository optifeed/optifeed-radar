# Optifeed Visibility - Development Plan (Modular, Agent-Ready)

Status: approved scope, 2026-07-15. This is the build handoff document:
each module below is sized to be assigned to a separate agent/model session.
Strategy and product rationale live in `optifeed-visibility-source-of-truth.html`
(this doc assumes those decisions and does not re-argue them).

Numbering note (2026-07-15): renumbered to a clean M0-M17 sequence. Output
was split into a data contract (M8) + renderers (M9); a dedicated run
orchestrator (M10) was inserted; the ACP/UCP spec spike is now its own
module (M13) ahead of lint-feed (M14). Module numbers are labels, not a
strict build order - the dependency graph and wave table below define order.

## Global decisions (apply to every module)

- **Repo:** `optifeed/visibility`, single npm package `optifeed-visibility`,
  MIT license.
- **Stack:** TypeScript strict, Node >= 20, ESM only. CLI via `commander`.
  MCP via official `@modelcontextprotocol/sdk` (stdio transport). Tests via
  `vitest`. HTML parsing via `cheerio`. YAML via `yaml`. No heavy deps
  without reason; every added dependency must be justified in the PR.
- **Layout:**

```
optifeed-visibility/
  src/
    core/          # all logic; NEVER imports from cli/ or mcp/
      types.ts     # M1
      config.ts    # M1
      costs.ts     # M1
      fetcher/     # M2
      audit/       # M3
      discovery/   # M4
      queries/     # M5
      engines/     # M6
      scoring/     # M7
      output/      # M8 data contract + M9 renderers
      run/         # M10 - the end-to-end orchestrator both CLI and MCP call
      shopping/    # M12
      lintfeed/    # M13 protocol spike + M14 rules
    cli/           # M11 - thin commander wrappers over core/run
    mcp/           # M15 - thin MCP tool wrappers over core/run
  skills/          # M16 - SKILL.md + agent surfaces
  .claude-plugin/  # M16
  test/fixtures/   # shared HTML/feed/answer fixtures
```

- **Hard rules for every agent:**
  1. `core/` must never import from `cli/` or `mcp/`. CLI and MCP are thin
     adapters; if you find logic in them, move it to core.
  2. Every JSON output and persisted file carries `schema_version` (start
     `"0.1"`). Breaking format changes bump it.
  3. No network calls in unit tests - fixtures only. Each module ships with
     fixtures under `test/fixtures/<module>/`.
  4. Never log or persist API keys. Keys come from env or config, stay in
     memory.
  5. Any operation that will spend LLM money must go through the cost guard
     (M1 `costs.ts`) - estimate first, never spend silently.
  6. Honest output: scores are estimates; anything derived from sampling
     says so in the output. No fake precision.
  7. Public API of each module = its `index.ts` exports. Other modules
     import only from module roots (`core/audit`, not `core/audit/robots`).
  8. This single-package `src/` layout is authoritative. The design doc
     (`source-of-truth.html`) still shows an older `packages/` monorepo and
     the tool names `audit_store`/`get_report`; where they differ, THIS plan
     wins (M15 owns final MCP tool names).
  9. One headline score. `check` surfaces exactly one 0-100 number (the AI
     Visibility Score from M7); the audit's own 0-100 (M3) is shown only in
     the standalone `audit` command and appears inside `check` as findings/
     explanations, never as a second competing score.

- **Definition of done (every module):** typecheck clean, vitest green,
  fixture coverage for happy path + at least 2 failure modes, exported
  API documented with TSDoc, and a `## Module report` comment in the PR
  describing deviations from this plan.

---

## Dependency graph / build order

```
M0 scaffold
 └─ M1 types + config + costs + JudgeClient interface
     ├─ M2 fetcher ──► M3 audit ──────────────────────────────┐
     │                                                         │
     ├─ M6 engine adapters (implements JudgeClient) ──┐        │
     │        │                                        │       │
     │        ▼                                        │       │
     ├─ M4 discovery (needs JudgeClient) ──► M5 queries│       │
     │        │                              │         │       │
     │        └──────────────┬───────────────┘         │       │
     │                       ▼                          ▼       │
     │              M7 scoring (needs M4 profile + M6 answers)  │
     │                       │                                  │
     │                       ▼                                  │
     │              M8 output data contract ◄───────────────────┤
     │                       │              (audit findings feed in)
     │                       ▼
     │              M10 core/run orchestrator  (wires M3+M4+M5+M6+M7+M8,
     │                       │                  runs cost guard, snapshots)
     │              M9 renderers (terminal + HTML) read the M8 envelope
     └─ (fixtures work can start once M1 types land)
M11 CLI  ◄─ thin adapter over M10; ship `audit` (needs M3) first, `check` when M10 lands
M12 shopping ◄─ M10 + new discovery adapters (reuses the orchestrator, swaps entity source)
M13 ACP/UCP protocol spike ──► M14 lint-feed ◄─ M2 only (independent parallel track)
M15 MCP ◄─ thin adapter over the SAME M10 orchestrator as M11 (owns final tool names)
M16 agent surfaces + README ◄─ after M11/M15 stabilize command names
M17 release + QA ◄─ last
```

Key edges the naive graph hides: **M4 and M5 make judge-model calls**, so they
depend on the `JudgeClient` interface (M1) that **M6 implements** - M4/M5
cannot complete before M6. **M7 depends on M4** (brand/aliases/domain for
mention detection, competitors for SoV) + M6, not M5. **M10 is the
orchestrator** every entrypoint (M11, M12, M15) adapts over; it is core, so
no run logic lives in `cli/` or `mcp/`.

**Parallelization:** after M1 lands, three agents can work simultaneously:
(A) M2→M3, (B) M6 (implements JudgeClient), (C) M13→M14 + fixtures. M4→M5
start once M6's JudgeClient lands; M7 starts once M4 + M6 land; M8→M10→M9
close the chain. M5/M7 are NOT independent of M6.
**Ship order:** `audit` first (zero API keys, instant win), then `check`,
then `shopping` beta, then MCP + surfaces.

---

## M0 - Scaffold

**Goal:** empty but runnable repo.
**Deliverables:** package.json (`bin: {"optifeed-visibility": "dist/cli/index.js"}`),
tsconfig (strict, ESM, NodeNext), vitest config, eslint+prettier, GitHub
Actions CI (typecheck+test on PR), LICENSE (MIT), `.optifeed/` in .gitignore,
placeholder README ("launching soon" + star CTA - repo may be public before
launch), **CLAUDE.md** (copy from
`optifeed-visibility-repo-claude-md.md` in the project folder - the agent
guideline file; also copy this dev plan into the repo as `docs/dev-plan.md`
so agents working in the repo can read it).
**Acceptance:** `npx tsx src/cli/index.ts --version` prints version;
CI green on a trivial test.

## M1 - Types, config, cost guard

**Goal:** the contracts every other module imports.
**Deliverables:**

- `types.ts`: `BrandProfile`, `QueryPack`, `EngineAnswer`, `MentionResult`,
  `EngineScore`, `VisibilityReport`, `AuditReport`, `Snapshot`,
  `ProductEntity`, `SkuReport`, `Finding` (severity, message, evidence,
  affected engines). All serializable, all with `schema_version`.
  `VisibilityReport` carries the honesty flags surfaced by M10:
  `costCapped?`, `skippedEngines[]`, `degraded?` (the report never hides a
  partial or capped run).
- `config.ts`: resolution order flags > `optifeed.yml` > env > defaults.
  Key detection (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY,
  PERPLEXITY_API_KEY). Judge-model selection state: explicit user choice
  persisted in config; `resolveJudgeModel({interactive})` - prompts when
  interactive and unset, falls back to cheapest available with a printed
  notice when non-interactive (CI/MCP/--yes). State dir resolution:
  `./.optifeed/` if cwd is writable project, else `~/.optifeed/<domain>/`.
- `costs.ts`: per-model $/1M token table (checked-in constant with a
  `lastUpdated` field), `estimateRun(nPrompts, engines, judgeModel)`,
  `CostGuard` (accumulates actuals, enforces `--max-cost`). **Abort contract:
  hitting the cap NEVER throws** - the guard stops further spend and the run
  returns a partial result flagged `costCapped: true` with a note (honest-
  output rule). Two-phase budget: a small **setup budget** pre-authorizes the
  discovery competitor call (M4) + query-gen call (M5) - which must run before
  we can estimate the main ASK - under a default cap (`--max-setup-cost`,
  ~$0.05); the main ASK gets its own printed estimate + confirm. This closes
  the "estimate first, never spend silently" gap for the two pre-ASK spends.
- `JudgeClient` interface (the seam that lets M4/M5 make one judge call
  WITHOUT importing M6): `{ complete(prompt, opts): Promise<{text, costUsd,
model}>; model: string }`. M1 declares it and `resolveJudgeModel` returns
  which model to use; **M6 provides the concrete implementation**. M4 and M5
  depend only on this interface, so they compile and unit-test against a
  mock and don't block on M6's full adapter suite landing.
  **Acceptance:** unit tests for config precedence, judge fallback matrix
  (interactive × keys present), estimate math, JudgeClient mock round-trip,
  and CostGuard cap → partial-result-not-throw.

## M2 - Fetcher

**Goal:** all outbound HTTP for site content in one place.
**Deliverables:** `fetchUrl` (timeout, redirects, max size, honest UA
`optifeed-visibility/<version>`), `fetchRobots`, `fetchSitemap` (index +
child sitemaps, cap N urls), `fetchLlmsTxt`, `extractPage(html)` →
{title, metaDescription, og, jsonLd[], h1, links, lang} via cheerio.
In-run memory cache keyed by URL. Graceful failure objects, never throws
raw network errors upward.
**Acceptance:** fixtures for redirect chain, 404, huge page truncation,
malformed HTML, sitemap index recursion.

## M3 - Audit engine (zero-LLM) — FIRST SHIPPABLE

**Goal:** instant static AI-readiness audit; also the "why" layer merged
into `check` reports.
**Checks (each a pure function → `Finding[]`):**

- robots.txt: rules for GPTBot, OAI-SearchBot, ClaudeBot, anthropic-ai,
  PerplexityBot, Google-Extended, GoogleOther, CCBot, meta-externalagent
  (table-driven; bot list is a checked-in constant that's easy to extend).
- llms.txt: present, non-empty, has links; llms-full.txt.
- Structured data: JSON-LD presence, Organization/WebSite/Product types,
  schema richness on sampled pages.
- Meta basics: title, description, canonical, OG, `<html lang>`.
- Sitemap present + parseable.
  **Output:** `AuditReport` {score 0-100 (published weights), findings
  sorted by severity, per-bot access table}.
  **Acceptance:** fixture sites: perfect site, robots-blocks-GPTBot,
  no-llms-txt, schema-less. Score stable across runs (deterministic).

## M4 - Discovery (domain → BrandProfile)

**Goal:** one argument in, editable brand profile out.
**Depends on:** M2 (fetch) + M1 `JudgeClient` interface (NOT M6 directly -
inject a `JudgeClient`; unit-test against a mock).
**Deliverables:** homepage + up to 5 sitemap pages → extract brand name,
aliases (og:site_name, JSON-LD Organization, domain stem), category
description, offerings, locale; competitor candidates via ONE judge-model
call through the injected `JudgeClient` (billed to the cost guard's setup
budget, see M1). Persist `profile.json` (+ `schema_version`,
`generatedAt`, `source` per field: `extracted` | `llm` | `user`).
`--refresh` regenerates; user edits win (never overwrite `user` fields).
Fallback: `--brand`/`--category` flags build a profile with no fetch
(mark `degraded: true`, audit/citation features flag themselves off).
**Acceptance:** fixtures for schema-rich site, meta-only site, JS-shell
site (falls back to flags gracefully); profile merge rules.

## M5 - Query generation

**Goal:** realistic buyer prompts, editable, reusable.
**Depends on:** M4 (profile) + M1 `JudgeClient` (injected, mock in tests -
not a hard M6 dependency). Generation call bills the cost guard setup budget.
**Deliverables:** judge-model generation from profile: default 20 prompts
across intent types `best-of | comparison | problem | trust | local`
(skip local when profile has no geo). Write `queries.yml` (schema_version,
intents, editable). Load + validate on subsequent runs; regenerate only on
`--regenerate`. Rule: competitor names NEVER appear in generated prompts
(bias); competitors used only at scoring. Support `--queries <file>`.
`export` helper so packs can be shared (future Prompt Library format).
**Acceptance:** golden-file test with mocked judge; intent distribution;
competitor-exclusion test; hand-edited file survives reruns.

## M6 - Engine adapters

**Goal:** uniform interface over 4 providers, partial-failure tolerant.
**Interface:**

```ts
interface EngineAdapter {
  id: 'openai' | 'anthropic' | 'gemini' | 'perplexity';
  kind: 'parametric' | 'grounded';
  available(cfg): boolean; // key present
  ask(prompt, opts): Promise<EngineAnswer>; // {text, citations?, model, tokens, costUsd, ts}
}
```

- openai: chat (parametric) + Responses/web_search variant (grounded)
  behind one adapter with `mode` option.
- anthropic: parametric.
- gemini: parametric + search-grounding when available; degrade with a
  warning, not an error.
- perplexity: grounded (sonar); citations expected and always parsed, but
  their absence downgrades the result (`citationsMissing: true`), never
  throws - one adapter's shape never kills the run.
- Shared: p-limit concurrency (default 4/provider), exponential backoff
  on 429/5xx (max 3), per-call cost recording into CostGuard, timeout.
- Runner: `askAll(prompts, adapters)` → matrix + `skippedEngines[]` with
  reasons. One adapter's total failure never kills the run.
- **Provides the `JudgeClient` implementation** (M1 interface) so M4/M5 get a
  real judge model at wiring time while depending only on the interface.
  **Acceptance:** all tests against mocked HTTP; retry/backoff paths;
  partial-run result shape; cost accumulation; `JudgeClient` conformance.
  **Note:** keep each provider file under ~200 lines; new engines (Grok,
  DeepSeek) must be addable by copying one file + registering.

## M7 - Scoring

**Goal:** answers → mentions → scores, honestly.
**Depends on:** M4 (profile: brand/aliases/domain + competitors) + M6
(engine answers, and the judge model for pass 2). NOT M5.
**Deliverables:**

- Mention detection, hybrid: pass 1 deterministic (brand + aliases + domain
  match, word-boundary, fuzzy accents/case); pass 2 judge-model ONLY for
  ambiguous answers (mentioned-but-unclear-position, generic brand words).
  Budget: judge calls ≤ 30% of answers, through cost guard.
- Per answer: mentioned, position among recommended entities (1-based,
  null if unranked), sentiment (pos/neu/neg), all entities list (SoV),
  cited domains (grounded engines).
- Aggregation: per-engine score = f(mention_rate, avg position, sentiment
  modifier) → 0-100; composite = weighted mean (grounded engines weight
  higher); formula + weights in `METHODOLOGY.md` (deliverable of this
  module, published verbatim).
- Share-of-voice table vs profile competitors; sources aggregation.
  **Acceptance:** golden answer fixtures (incl. tricky: brand as common word,
  competitor-only answers, non-English); judge-budget cap enforced; formula
  reproduces documented examples in METHODOLOGY.md.

## M8 - Output data contract — ON THE CRITICAL PATH

Output is split across two modules: **M8 (data contract)** and **M9
(renderers)**. Everything downstream (M10, M11, M12, M15) depends only on
this contract; the renderers can lag. Ship M8 first.

**Goal:** the one stable shape every consumer reads.
**Depends on:** M7 (scores) + M3 (audit findings feed into the envelope).
**Deliverables:**

- `--json` stable envelope {schema_version, generatedAt, profile, scores,
  engines, findings, sampling: {nPrompts, variance-note}, costCapped?}.
- Snapshots: save full JSON to `.optifeed/snapshots/<ISO>.json`;
  `diff(a,b)` → won/lost prompts per engine, score delta. Prompt identity
  must be stable across runs (queries only regenerate on `--regenerate`);
  a fixture covers a hand-edited/refreshed pack changing prompt identity.
- Exit codes: `--fail-under <n>` (CI mode).
  **Acceptance:** JSON schema snapshot test (breaking change = failing test
  forcing schema_version bump); diff golden tests incl. changed-prompt-set.

## M9 - Output renderers

**Goal:** human-readable surfaces over the M8 envelope. Can land after M10.
**Depends on:** M8 (reads the envelope; never re-derives from raw data).
**Deliverables:**

- Terminal renderer (the landing page's example output IS the spec: score
  block, per-engine lines, warn/miss findings, report path). No color libs
  beyond `picocolors`.
- HTML report: single self-contained file, dark theme matching the landing
  mockup, embeds raw answers behind expandable sections (evidence rule),
  agency-friendly header (brand + date). Template = TS string literals, no
  templating dep.
- Every human-readable output ends with the footer CTA line (from messaging
  guide; single constant in one file).
  **Acceptance:** HTML renders with zero external requests; terminal output
  matches the landing spec; both consume only the M8 envelope (no re-derive).

## M10 - Run orchestrator (`core/run`) — THE SEAM

**Goal:** the single end-to-end function every entrypoint (M11 CLI, M15 MCP,
M12 shopping) adapts over, so no pipeline logic ever lives in `cli/`/`mcp/`
(hard rule #1). This module is what makes `check` reusable.
**Depends on:** M3, M4, M5, M6, M7, M8.
**Deliverables:**

- `runCheck(domain, opts)`: discover (M4) → setup-budget confirm → generate
  queries (M5) → estimate main ASK + confirm/`--yes` → ask (M6) → score (M7)
  → merge audit findings (M3) → assemble the M8 envelope → write snapshot.
  Returns the envelope (never renders - callers render via M9).
- Honors the cost guard's two-phase budget and the partial/`costCapped`
  contract; surfaces `skippedEngines` and degraded flags upward.
- `runAudit(domain, opts)` thin path for the zero-key `audit` command (M3
  only, no LLM), sharing the same fetcher and envelope subset.
- Injection points: adapters (M6) and `JudgeClient` are passed in, so tests
  drive the whole pipeline with mocks and no network.
  **Acceptance:** end-to-end test with mocked adapters/JudgeClient/fetcher:
  audit-only run (no keys), full `check` run, `--yes` non-interactive path,
  `--max-cost` mid-run cap → partial envelope with `costCapped: true`.

## M11 - CLI assembly

**Goal:** the commands as marketed.
**Depends on:** M10 + M9. Commands are THIN wrappers - each parses flags,
calls `runCheck`/`runAudit` (M10), and hands the returned envelope to an M9
renderer. The discover→confirm→queries→estimate→ask→score→output flow lives
in M10, NOT here (hard rule #1); if orchestration creeps into `cli/`, it's a
bug. Ship `audit` first (needs only M3 via `runAudit`), grow as modules land.
**Commands:** `audit <domain>` · `check <domain>` (runs `runCheck`; includes
audit findings; `--yes`, `--engines`, `--max-cost`, `--max-setup-cost`,
`--json`, `--report`, `--quick` [=8 prompts]) · `compare <domain>
--competitors a,b` · `sources <domain>`
· `queries <domain>` · `diff <domain>` · `shopping <domain>` (M12) ·
`lint-feed <url>` (M14) · `mcp` (M15) · `config`.
Interactive prompts via `@inquirer/prompts`, ALWAYS bypassable (`--yes`

- flags) - agents are first-class users of the CLI too.
  **Acceptance:** e2e tests with mocked adapters: audit-only run with no
  keys; check with 1 key; full run; `--json` piped output clean (no ANSI).

## M12 - Shopping beta

**Goal:** SKU-level checks for Shopify + feed stores (launch beta scope).
**Depends on:** M10 (reuses the orchestrator) + new discovery adapters below.
**Deliverables:**

- Adapters → `ProductEntity[]`: `shopify.ts` (public `/products.json`,
  paginate, detect via response shape) · `feed.ts` (Google Shopping XML +
  CSV; reuse parsing conventions from the Rails app where sensible).
- Sampler: cluster products into categories via judge model (one call),
  pick top-N per category (default 3, cap 20 total SKUs per run).
- Shopping query pack: category-level buying prompts + hero-SKU prompts.
- Reuse the M10 orchestrator verbatim, parameterized by entity source
  (catalog instead of brand profile - this is the Stage-1 seam); per-SKU
  results → `SkuReport` (which SKUs recommended/invisible, per engine,
  evidence). If M10 needs changes to accept a catalog source, that's a
  small generalization of `runCheck`, not a fork.
- Output: terminal + JSON + report section; findings cross-reference
  lint-feed (M14) results when available ("Presto X never appears AND fails
  ACP gtin check").
  **Acceptance:** fixture Shopify catalog + fixture feeds; sampling
  determinism given seed; graceful "not a Shopify store, no feed given"
  message pointing to `--feed`.
  **Explicitly out of beta scope:** VTEX/Woo adapters, crawl discovery,
  full-catalog runs.

## M13 - ACP/UCP protocol spike — DO BEFORE M14

**Goal:** de-risk M14 by pinning down unstable spec requirements first.
**Why separate:** the ACP/UCP specs are a live protocol war and their
requirements shift; embedding the research inside M14 would block the rule
table on external ambiguity mid-build.
**Deliverables:** a short checked-in `PROTOCOL-NOTES.md` capturing verified
current ACP and UCP field requirements (with source URLs + retrieval date):
required fields, identifier rules (GTIN/MPN/brand), availability/price
formats, image/return-policy signals, and any protocol-specific extras.
This document IS the input to M14's rule set. Re-verify at release (M17).
**Acceptance:** every requirement in the notes cites a source + date; a
reviewer can map each future M14 rule back to a line here.

## M14 - lint-feed (ACP + UCP) — INDEPENDENT TRACK

**Goal:** validate product feeds against both agentic-commerce protocols.
**Depends on:** M2 (fetch) + M13 (protocol notes). Independent of the
LLM pipeline - a good early parallel track.
**Deliverables:** rule engine (rule = {id, protocol: "acp"|"ucp"|"both",
severity, test(product), message, docsUrl}); initial rule set ported from
the Rails feed-quality logic (required fields, GTIN/MPN/brand identifiers,
description depth, availability/price format, image, return-policy
signals) + protocol-specific requirements from the M13 spike. Output:
per-product findings + feed-level summary score + protocol-readiness
verdict per protocol.
**Acceptance:** fixture feeds (clean, missing-GTIN, thin descriptions,
malformed XML); rules table-driven so a non-engineer can review coverage.

## M15 - MCP server

**Goal:** the same capabilities, agent-native.
**Depends on:** M10 - tools call the SAME `runCheck`/`runAudit` as M11, never
their own pipeline. This module owns the FINAL tool names (authoritative over
the design doc's `audit_store`/`get_report`).
**Tools** (names are the marketed API): `check_visibility(domain, engines?,
quick?)` · `compare_competitors(domain, competitors[])` · `audit_store(domain)`
· `generate_buyer_queries(domain)` · `shopping_check(domain|feedUrl)` ·
`lint_feed(url)` · `get_snapshot_diff(domain)`.

- stdio transport, official SDK. Non-interactive semantics everywhere
  (auto profile confirm, judge fallback, default cost cap - document it).
- Tool descriptions written FOR agents (include when-to-use + cost hints).
- Long runs: MCP progress notifications; results also saved to disk so
  the agent can reference the report path.
  **Acceptance:** integration test speaking MCP over stdio (initialize,
  list_tools, call audit_store with fixture domain via mocked fetcher);
  tool JSON schemas snapshot-tested.

## M16 - Agent surfaces + README

**Goal:** the distribution artifacts, per the playbook research.
**Deliverables:** root `SKILL.md` (OpenClaw/ClawHub format: frontmatter
requirements env/binaries, command reference) · `.claude-plugin/` manifest
· `ai-context/` files (claude-project.md, chatgpt-custom-gpt.md,
cursor.mdc, windsurf.md) · README with: badge wall (npm, downloads, MIT,
glama, smithery placeholders), 60-Second Setup, per-client config blocks
(Claude Desktop/Claude Code/Cursor/Windsurf, exact paths), tools table,
example prompts + sample output, cost transparency table, FAQ (mirror
landing FAQ), **Directory Listing Copy section** (pre-written one-liners
for awesome-mcp-servers [📇 🏠, `npx -y optifeed-visibility`], ClawHub,
Smithery), search-intents block, honest "what this does NOT do" section.
Copy MUST pass the messaging guide (no free-vs-paid equivalence, tense
rules, em-dash ban).
**Acceptance:** review against messaging-guide checklist; SKILL.md
validates against ClawHub schema; every config snippet tested by pasting.

## M17 - Release engineering + launch QA

**Goal:** publish clean, verify real-world.
**Deliverables:** npm publish workflow (provenance, `files` whitelist),
version + changelog convention (weekly release cadence is a marketing
mechanic - make cutting a release trivial), smoke-test script that runs
`audit` + `--quick check` against 3 real domains with real keys (manual
gate, prints cost), README badge URLs live, `npx` cold-run timing (<60s
to first output), Windows/macOS/Linux CI matrix, `SECURITY.md`.
Launch-week support: the 100-brand data run script (batch `check --quick
--json` over a list, aggregate stats for the launch article) - budgeted
via cost guard.
**Acceptance:** `npm pack` contents reviewed; cold `npx` run works in a
clean container; data-run script produces the aggregate JSON the article
needs.

---

## Suggested agent assignment

| Wave | Agent A                                  | Agent B                      | Agent C                          |
| ---- | ---------------------------------------- | ---------------------------- | -------------------------------- |
| 1    | M0 + M1 (types/config/costs/JudgeClient) | test fixtures library        | -                                |
| 2    | M2 → M3                                  | M6 (implements JudgeClient)  | M13 spike → M14                  |
| 3    | M4 → M5                                  | M7 (starts when M4 lands)    | M8 data contract                 |
| 4    | M10 orchestrator → M9 renderers          | M11 CLI (after M10)          | M12 shopping (after M10)         |
| 5    | M15 MCP                                  | M16 surfaces (after M11/M15) | M17 + landing/README copy review |

**Handoff notes (the intra-wave dependencies a flat table hides):**

- Wave 3 A/B need M6's `JudgeClient` from Wave 2 - M4/M5/M7 cannot start until
  M6 lands the interface impl.
- M7 (3B) needs M4's profile, so 3B waits for 3A to hand off M4 before scoring;
  A then continues to M5 in parallel.
- M10 (4A) needs M3+M4+M5+M6+M7+M8 all done (Waves 2-3). M11 (4B) and M12 (4C)
  need M10, so they start mid-Wave-4 once A ships `runCheck`/`runAudit`. If
  that stagger is uncomfortable, run M10 as its own short wave between 3 and 4.
- M16 (5B) needs M11 (Wave 4) + M15 (5A), so it starts after M15's tool names
  freeze.

Per-module agent brief template: "Read `optifeed-visibility-dev-plan.md`
module MX and the Global decisions section. Implement exactly that scope.
Do not touch other modules except backward-compatible additions to the
shared M1 surfaces (`types.ts` and the `JudgeClient` interface). Depend on
other modules only through their `index.ts` and injected interfaces (pass a
`JudgeClient`/adapters in, don't import M6 concretely). Ship with tests and
the Module report."
