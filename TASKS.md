# Optifeed Visibility - Build Tracker

Living checklist for the build. Source of scope: the dev plan
(`docs/dev-plan.md`, the authoritative in-repo copy). This file tracks
**status only** - it does not restate the plan. Keep the two in sync: if scope
changes, edit the plan first, then reflect it here.

> This is the canonical, in-repo copy (moved here when M0 scaffolded the repo).
> The planning-workspace copy is superseded.

Last updated: 2026-07-15.

## Legend

- `[ ]` not started · `[~]` in progress · `[x]` done (DoD met) · `[!]` blocked
- Each module is DONE only when its **Definition of Done** is met (see below).
- Fill `Owner` / `PR` when a module is picked up.

## Definition of Done (every module)

- [ ] typecheck clean · [ ] vitest green · [ ] fixtures: happy path + ≥2 failure modes
- [ ] exported API has TSDoc · [ ] `## Module report` in the PR (deviations noted)
- [ ] respects the global hard rules (see Invariants below)

## Ship milestones (the gates that matter)

- [~] **`audit` ships** - runnable end to end (`audit <domain>`, zero-key), verified live. Minimal slice: seeds of M9 (text/JSON renderers), M10 (`runAudit`), M11 (`audit` command). Still pending for full M8/M9/M10/M11: snapshots, HTML report, `--fail-under` exit code, colorized output.
- [ ] **`check` ships** - full pipeline with ≥1 engine key (M4-M8, M10, M11 check cmd)
- [ ] **`shopping` beta ships** - Shopify + `--feed`, sampled SKU checks, lint-feed (M12 + M13-M14)
- [ ] **MCP ships** - stdio server over the same core (M15)
- [ ] **Public launch** - surfaces + README + release QA + conversion surfaces live (M16, M17)

---

## Wave 1 - foundations

### [x] M0 - Scaffold

Owner: setup · PR: (initial)

- [x] package.json (`bin` map), tsconfig (strict/ESM/NodeNext), vitest, eslint+prettier
- [x] GitHub Actions CI (typecheck + lint + format + test + build on PR), LICENSE (MIT), `.optifeed/` gitignored
- [x] placeholder README ("launching soon" + star CTA)
- [x] Acceptance: `npx tsx src/cli/index.ts --version` prints version (0.0.0); `node dist/cli/index.js --version` works; `npm run check` green
- Module report: added `tsconfig.build.json` (rootDir `src`) so build emits `dist/cli/index.js` matching `bin`; base tsconfig keeps rootDir `.` for typecheck over src+test. Version resolved at runtime via `getVersion()` (fs read of package.json, layout-agnostic). CI also runs `format:check` and `build` beyond the plan's minimum.

### [x] M1 - Types, config, cost guard, JudgeClient

Owner: setup · PR: (M1)

- [x] `types.ts` - `EngineId`, `Finding`, `BrandProfile`, `EngineAnswer`, `JudgeClient`, `RunHonesty` (`costCapped`/`skippedEngines`/`degraded`), `SCHEMA_VERSION` = "0.1"
- [x] `config.ts` - `detectAvailableEngines`, `resolveConfig` (flags > file > env > defaults), `resolveJudgeModel` fallback matrix (saved → prompt → cheapest+notice → throws `NoJudgeModelError`), `resolveStateDir`
- [x] `costs.ts` - `MODEL_PRICING` (+`lastUpdated`), `costOfCall`, `estimateRun`, `CostGuard` (two-phase setup/main budget; cap → `costCapped`, never throws)
- [x] `JudgeClient` interface + mock round-trip test composing with the cost guard's setup phase
- [x] `core/index.ts` barrel (public API per hard rule #7)
- [x] Acceptance: config precedence, judge fallback matrix, estimate math, JudgeClient round-trip, CostGuard cap→partial-not-throw. 25 tests green; typecheck/lint/format/build clean.
- Module report: config/costs are pure and dependency-injected (env, prompt, fs-writability, adapters all passed in) so the whole matrix tests with no real environment or network. Data types beyond M1's own needs (VisibilityReport, AuditReport, Snapshot, QueryPack, MentionResult, EngineScore, ProductEntity, SkuReport) deferred to their owning modules as backward-compatible additions rather than speculated here. Prices in MODEL_PRICING are approximate estimate inputs, not billing.

### [ ] Fixtures library (shared)

Owner: ___ · PR: ___

- [ ] `test/fixtures/` HTML/feed/answer fixtures scaffolded (starts once M1 types land)

---

## Wave 2 - parallel tracks (need M1)

### [x] M2 - Fetcher

Owner: setup · PR: (M2)

- [x] `fetchUrl` (timeout/redirects/max-size/honest UA), `fetchRobots`, `fetchSitemap`, `fetchLlmsTxt`, `extractPage`
- [x] in-run URL cache; graceful failure objects (never throws raw)
- [x] Acceptance fixtures: redirect chain, 404, huge-page truncation, malformed HTML, sitemap recursion
- Module report: `createFetcher({ fetchImpl })` factory holds the in-run cache and takes an injected fetch, so all 12 tests run with a fake router and zero network. Manual redirect following (`redirect: 'manual'`) to report `finalUrl` and cap hops. Body cap truncates by UTF-16 length (approx). `extractPage` is pure cheerio. Fixtures in `test/fixtures/fetcher/` and excluded from prettier (intentionally malformed).

### [x] M3 - Audit engine (zero-LLM) — FIRST SHIPPABLE

Owner: setup · PR: (M3)

- [x] robots.txt bot table (9 AI bots) · llms.txt · JSON-LD/schema · meta basics · sitemap
- [x] `AuditReport` (score 0-100 published weights `AUDIT_WEIGHTS`, findings sorted by severity, per-bot access table)
- [x] `gatherAuditInput(domain, fetcher)` assembles inputs via M2 (nulls on fetch failure)
- [x] Acceptance: perfect(=100) / robots-blocks-GPTBot / no-llms-txt / schema-less; deterministic (report equality across runs)
- Module report: `buildAuditReport` is pure/deterministic (no clock, no network) - score stability comes for free. Published weights robots 40 / structured 25 / llms 15 / meta 15 / sitemap 5. Structured scoring does NOT require Product schema (would unfairly penalize non-ecommerce brands); Product presence is an info finding only. Added `canonical` to M2 `extractPage` (backward-compatible) for the meta check. Note: METHODOLOGY.md publishing of these weights is owned by M7/M8 output; the constant is the source of truth.

### [x] M6 - Engine adapters (implements JudgeClient)

Owner: setup · PR: (M6)

- [x] openai (chat + Responses/web_search mode), anthropic, gemini (grounding when asked, degrades not errors), perplexity (citations degrade not throw)
- [x] shared: per-provider concurrency cap (`mapLimit`), exponential backoff on 429/5xx, per-call cost → CostGuard, timeout (all injectable)
- [x] `askAll` runner + `skippedEngines[]` (total failure never kills the run); **`createJudgeClient` provides the M1 `JudgeClient` impl**
- [x] each provider file is a small `ProviderSpec` (endpoint/buildRequest/parse); new engine = copy one spec + one registry line
- [x] Acceptance: mocked HTTP throughout, retry/backoff paths, partial-run shape, cost accumulation, JudgeClient conformance. 18 new tests; 72 total green.
- Module report: `createAdapter(spec, deps)` wraps a provider spec with shared retry/cost/clock; `httpPost`, `sleep`, `now`, `apiKey` all injected so every path tests with no network and deterministic timestamps. Wire shapes for parametric endpoints match real APIs; OpenAI grounded (Responses) and Gemini grounding use simplified shapes to be firmed up at the M17 smoke test. `defaultHttpPost` wraps global fetch for production.

### [ ] M13 - ACP/UCP protocol spike (do before M14)

Owner: ___ · PR: ___

- [ ] `PROTOCOL-NOTES.md` - verified ACP + UCP field requirements with source URLs + dates
- [ ] Acceptance: every requirement cites source + date; maps to future M14 rules

### [ ] M14 - lint-feed (ACP + UCP) — INDEPENDENT TRACK

Owner: ___ · PR: ___ · needs M2 + M13

- [ ] rule engine (`{id, protocol, severity, test, message, docsUrl}`); rules ported from Rails + M13 spike
- [ ] per-product findings + feed-level score + per-protocol readiness verdict
- [ ] Acceptance fixtures: clean / missing-GTIN / thin-desc / malformed XML; table-driven

---

## Wave 3 - pipeline (need M6's JudgeClient)

### [x] M4 - Discovery (domain → BrandProfile)

Owner: setup · PR: (M4) · needs M2 + M1 JudgeClient

- [x] extract brand/aliases/category/offerings/locale; ONE competitor call via injected JudgeClient (setup budget)
- [x] persist `profile.json` (source per field); `--refresh`; user edits win
- [x] `--brand`/`--category` fallback (mark `degraded`)
- [x] Acceptance: schema-rich / meta-only / JS-shell fixtures; merge rules
- Module report: split into pure + I/O. Pure: `extractSignals` (deterministic brand/aliases/category/offerings/locale from M2 `ExtractedPage[]`, JSON-LD walked for objects/arrays/`@graph` per lesson #4) and `profile.ts` (`buildProfile`, `buildProfileFromFlags`, `mergeProfile`). I/O: `discoverCompetitors` (the one judge call, `estimateJudgeCallUsd`→`guard.authorize('setup')`→`record`; cap or judge error degrades to `[]` with a reason, never throws - lessons #3/#5), `persist.ts` (injected `ProfileFs`; corrupt file throws `ProfileParseError` rather than clobbering), and the `discover` orchestrator (fetcher/judge/guard/fs/clock all injected). Depends only on the M1 `JudgeClient` interface - no M6 import (carried-risk item cleared). Decisions: brand priority og:site_name > JSON-LD Organization/WebSite name > domain stem; domain stem skips common second-levels (`acme.co.uk`→`acme`). `--brand`/`--category` take the no-fetch degraded path outright (also how a JS-shell site "falls back to flags"). `degraded` reserved for the flags path only; a cost-capped competitor call leaves `competitors: []` and surfaces via the guard's `costCapped`, not `degraded`. Backward-compatible M1 additions: `ProfileField`/`ProfileSources` types + `BrandProfile.sources`; `estimateJudgeCallUsd` in `costs.ts` (unknown model → priciest-entry fallback, lesson #2). 20 new tests (104 total); verified end-to-end through the real M2 fetcher.

### [x] M5 - Query generation

Owner: setup · PR: (M5) · needs M4 + JudgeClient

- [x] 20 prompts across intents (skip local w/o geo); write `queries.yml`; validate on reruns; `--regenerate` only
- [x] competitor names NEVER in prompts; `--queries <file>`; `export` helper
- [x] Acceptance: golden mocked-judge, intent distribution, competitor-exclusion, hand-edit survives
- Module report: pure core (`activeIntents`, `parseIntentQueries`, `excludeCompetitors`, `buildQueryPack`) + one I/O fn (`generateQueries`, ONE guarded judge call on the setup budget; cap/judge-error degrade to an empty pack, never throw) + `persist.ts` (yaml, validated load; corrupt/invalid file throws `QueryPackError` not clobber) + the `resolveQueries` orchestrator (`--queries` file > cached `queries.yml` (hand edits survive) > generate on `--regenerate`). Depends only on the M1 `JudgeClient` interface - no M6 import (carried-risk item cleared for M5). Decisions: competitor names are WITHHELD from the generation prompt (not just filtered) - "used only at scoring"; `buildQueryPack` still strips any that slip in as a defensive bias guard, and prompts round-robin across intents so a capped pack stays balanced. `local` intent gated on a new backward-compatible `BrandProfile.geo` (absent by default -> local skipped). Added `yaml` dep (M5 owns it, per the plan). Backward-compatible M1 additions: `QueryIntent`, `Query`, `QueryPack`, `BrandProfile.geo`. Golden fixture (`test/fixtures/queries/golden-pack.yml`) pins the on-disk format AND proves the bias rule end to end (an "Estes" prompt is stripped, so an 8-target pack honestly yields 7). 24 new tests (128 total).

### [x] M7 - Scoring (starts when M4 lands)

Owner: setup · PR: (M7) · needs M4 + M6 (NOT M5)

- [x] hybrid mention detection (deterministic pass 1, judge pass 2 ≤30% via cost guard)
- [x] per-answer: mentioned/position/sentiment/entities(SoV)/cited domains
- [x] per-engine + composite score; `METHODOLOGY.md` (published verbatim); SoV table
- [x] Acceptance: tricky golden fixtures (common-word brand, competitor-only, non-English); budget cap; formula matches doc
- Module report: `detect.ts` (pure pass 1 - accent/case fold + word-boundary match of brand/aliases/domain and competitors; entities by first appearance; position; lexicon sentiment; cited domains; generic-word brands flagged `ambiguous`). `judge.ts` (pass 2 - re-judges ONLY ambiguous results, capped at `floor(0.30 * answers)` AND gated by the cost guard on the `main` phase; cap/cost/judge-error all stop cleanly, never throw; a "not mentioned" verdict removes the false positive). `score.ts` (published formula + `SCORE_WEIGHTS` source of truth: engine 0-100 = `(0.6*mentionRate + 0.4*positionScore) * sentimentMod`; composite = grounded-weighted mean 1.5 vs 1.0; SoV; sources). `scoring.ts` orchestrator (pass1 -> pass2 -> aggregate -> `ScoreReport`; judge/guard injected, judge optional). `METHODOLOGY.md` published at repo root with two worked examples the tests reproduce (engine 59, composite 52). Depends only on M4 profile + M6 `EngineAnswer`/`JudgeClient` shapes (imports `../types` + `../costs`, not `../engines`). Backward-compatible M1 additions: `Sentiment`, `MentionResult`, `EngineScore`, `ShareOfVoiceRow`, `SourceRow`, `ScoreReport`. Golden fixtures: `test/fixtures/scoring/{answers.json,golden-report.json}` (accented brand "Café Rio", competitor-only answers, grounded citations, mixed engine kinds -> composite 61). 23 new tests (151 total).

### [ ] M8 - Output data contract — ON THE CRITICAL PATH

Owner: ___ · PR: ___ · needs M7 + M3

- [ ] `--json` stable envelope; snapshots to `.optifeed/snapshots/`; `diff(a,b)`; `--fail-under`
- [ ] Acceptance: JSON schema snapshot test (break→bump), diff golden incl. changed-prompt-set

---

## Wave 4 - orchestration + entrypoints (need M8)

### [ ] M10 - Run orchestrator (`core/run`) — THE SEAM

Owner: ___ · PR: ___ · needs M3,M4,M5,M6,M7,M8

- [ ] `runCheck(domain,opts)` wires the full pipeline + two-phase budget + snapshot; returns envelope (no render)
- [ ] `runAudit(domain,opts)` zero-key path; injection points for adapters/JudgeClient/fetcher
- [ ] Acceptance e2e (all mocked): audit-only, full check, `--yes`, mid-run `--max-cost` → `costCapped`

### [ ] M9 - Output renderers (can land after M10)

Owner: ___ · PR: ___ · needs M8

- [ ] terminal renderer (landing output = spec; picocolors only)
- [ ] self-contained HTML report (dark theme, evidence sections, agency header); footer CTA constant
- [ ] Acceptance: HTML zero external requests; consumes only M8 envelope

### [ ] M11 - CLI assembly (after M10)

Owner: ___ · PR: ___ · thin over M10 + M9

- [ ] commands: `audit` `check` `compare` `sources` `queries` `diff` `shopping` `lint-feed` `mcp` `config`
- [ ] all interactive prompts bypassable (`--yes` + flags); ship `audit` first
- [ ] Acceptance e2e mocked: audit no-key, check 1-key, full, clean `--json` (no ANSI)

### [ ] M12 - Shopping beta (after M10)

Owner: ___ · PR: ___

- [ ] `shopify.ts` (`/products.json`) + `feed.ts` (Google XML/CSV) → `ProductEntity[]`
- [ ] sampler (category clustering, top-N, cap 20 SKUs); shopping query pack
- [ ] reuse M10 (catalog entity source); `SkuReport`; cross-ref M14 findings
- [ ] Acceptance: fixture catalog + feeds; seeded sampling determinism; graceful non-Shopify message
- [ ] OUT of beta scope: VTEX/Woo, crawl discovery, full-catalog

---

## Wave 5 - distribution + release

### [ ] M15 - MCP server

Owner: ___ · PR: ___ · thin over M10 (owns final tool names)

- [ ] tools: check_visibility / compare_competitors / audit_store / generate_buyer_queries / shopping_check / lint_feed / get_snapshot_diff
- [ ] stdio + official SDK; non-interactive semantics; agent-written tool descriptions; progress notifications + disk results
- [ ] Acceptance: MCP-over-stdio integration test; tool JSON schemas snapshot-tested

### [ ] M16 - Agent surfaces + README (after M11/M15)

Owner: ___ · PR: ___

- [ ] `SKILL.md` (ClawHub) · `.claude-plugin/` manifest · `ai-context/` (claude/chatgpt/cursor/windsurf)
- [ ] README: badge wall, 60-Second Setup, per-client config blocks, tools + cost table, FAQ, Directory Listing Copy, "what it does NOT do"
- [ ] Acceptance: messaging-guide checklist pass; SKILL.md validates; every config snippet pasted-and-tested

### [ ] M17 - Release engineering + launch QA

Owner: ___ · PR: ___

- [ ] npm publish workflow (provenance, `files` whitelist); changelog/weekly-release convention; `SECURITY.md`
- [ ] smoke-test script (3 real domains, prints cost); `npx` cold-run <60s; Win/macOS/Linux CI matrix
- [ ] 100-brand data-run script (budgeted) for the launch article
- [ ] Re-verify M13 protocol notes still current
- [ ] Acceptance: `npm pack` reviewed; cold `npx` in clean container; data-run aggregate JSON produced

---

## Cross-cutting invariants (re-check on every PR)

- [ ] `core/` never imports from `cli/` or `mcp/`
- [ ] every JSON output / persisted file carries `schema_version`
- [ ] no network in unit tests (fixtures only)
- [ ] API keys never logged or persisted (not in snapshots/reports)
- [ ] every LLM spend goes through the cost guard (estimate first)
- [ ] honest output - estimates labeled, sampling noted, no fake precision
- [ ] modules import only from other modules' `index.ts` / injected interfaces
- [ ] `check` surfaces ONE headline score (audit's 0-100 only in standalone `audit`)
- [ ] copy passes the messaging guide (no free-vs-paid equivalence, tense rules, em-dash ban)

## Review log

- 2026-07-15: high-effort workflow code review of M0–M6 (17 agents, 4 finder
  angles + adversarial verify). 10 verified findings, all fixed test-first in
  commit `d439065` (cost priced by configured model; `--max-cost` enforced in
  the runner; JSON-LD array recursion; sitemap parseability by content;
  non-JSON 2xx wrapped; gemini maxTokens; concurrent audit fetches; llms-full
  wired in; regex simplification). +8 regression tests.

## Carried risks / decisions to watch

- [x] Confirm M4/M5 truly depend only on `JudgeClient` (no concrete M6 import creeps in) - both cleared; discovery/ and queries/ import only `../types` + `../costs`, never `../engines`
- [ ] Confirm no orchestration logic leaks into `cli/`/`mcp/` (must live in M10)
- [ ] ACP/UCP spec churn - re-verify M13 notes before M14 rules AND at release (M17)
- [ ] Reserved "first" claim ("first open-source SKU-level AI shopping visibility tool") - re-verify when M12 ships
