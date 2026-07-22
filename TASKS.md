# Optifeed Radar - Build Tracker

Living checklist for the build. Source of scope: the dev plan
(`/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md`, the authoritative
copy in the docs repo). This file tracks **status only** - it does not restate
the plan. Keep the two in sync: if scope changes, edit the plan first, then
reflect it here.

> The dev plan moved to the `optifeed-radar-docs` git repo on 2026-07-18 (doc
> consolidation). `docs/dev-plan.md` in this repo is now a pointer stub to it.

> **SCOPE REVISION (2026-07-17): launch #1 is brand visibility only.** The
> commerce modules - M12 (shopping), M13 (protocol spike), M14 (lint-feed) -
> are deferred to a separate launch #2 (~4-8 weeks post-launch). Current build
> scope = M0-M11 + M15 (MCP) + M16 (agent surfaces) + M17 (release). M13's and
> M14's shipped code was **removed from the build** on 2026-07-17; their
> entries below are retained as history for launch #2 planning, not as status.
> The dev plan (`optifeed-radar-docs/dev-plan.md`) is authoritative and carries
> the same note.

Last updated: 2026-07-20.

## Legend

- `[ ]` not started · `[~]` in progress · `[x]` done (DoD met) · `[!]` blocked
- Each module is DONE only when its **Definition of Done** is met (see below).
- Fill `Owner` / `PR` when a module is picked up.

## Definition of Done (every module)

- [ ] typecheck clean · [ ] vitest green · [ ] fixtures: happy path + ≥2 failure modes
- [ ] exported API has TSDoc · [ ] `## Module report` in the PR (deviations noted)
- [ ] respects the global hard rules (see Invariants below)

## Ship milestones (the gates that matter)

- [x] **`audit` ships** - runnable end to end (`audit <domain>`, zero-key), verified live. Minimal slice: seeds of M9 (text/JSON renderers), M10 (`runAudit`), M11 (`audit` command). Everything that closed this milestone is now done: the HTML report (`--report`, `renderCheckHtml`), colorized output (`picocolors` in `terminal.ts`/`render-diff.ts`), M8 snapshot writing (`runCheck` calls `saveSnapshot`), and `--fail-under` (wired 2026-07-17, see M11).
- [x] **`check` ships** - full pipeline with ≥1 engine key (M4-M8, M10, M11 `check` cmd). Done at the code level: `runCheck` (M10) wires M3-M8, M9 renders, M11 `check` command is thin over both, all mocked-e2e covered. **LIVE-VERIFIED 2026-07-17** against real OpenAI (`check optifeed.com --quick --engines openai`): discovery → query-gen → 6 buyer prompts + 2 branded → scoring → share of voice → reputation split → snapshot, 34s, ask spend $0.0024. Confirmed live: no key material in the snapshot (rule #4), `schema_version` present, and the provider-echoed DATED model id (`gpt-4o-mini-2024-07-18`) still priced non-zero - the M0-M6 `$0`-cost bug regression-checked against reality. Still unverified live: anthropic, gemini, perplexity (no keys yet).
- [x] **MCP ships** - stdio server over the same M10 core (M15). 4 tools (check_visibility / audit_store / generate_buyer_queries / get_snapshot_diff), non-interactive with a default $0.50 cap; integration + schema-snapshot + failure-mode tested, and live-verified over real stdio (initialize + tools/list). Live multi-engine `check_visibility` still folds into the M17 smoke test (no non-OpenAI keys yet).
- [ ] **Public launch** - surfaces + README + release QA + conversion surfaces live (M16, M17)
- [ ] **`shopping` beta ships** - DEFERRED to launch #2 (not a launch #1 gate): Shopify + `--feed`, sampled SKU checks, lint-feed (M12 + M13-M14)

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

### [ ] M13 - ACP/UCP protocol spike - DEFERRED to launch #2

Owner: setup · PR: (M13)

> Built 2026-07-16, then **removed from the launch #1 build** (scope revision,
> 2026-07-17). No code was involved; the research doc survives at
> `docs/PROTOCOL-NOTES.md`, moved out of the repo root and re-headed as launch
> #2 planning input. The report below is history. Re-verify every source before
> launch #2 - these notes go stale fast.

- [x] `PROTOCOL-NOTES.md` - verified ACP + UCP field requirements with source URLs + dates (retrieved 2026-07-16, from PRIMARY sources only)
- [x] Acceptance: every requirement cites source + date; maps to future M14 rules (section 6 starter rule-map)
- Module report: research spike (no code). Went to primary sources only - OpenAI developer docs + the `agentic-commerce-protocol` and `universal-commerce-protocol` GitHub repos (spec + JSON schema files via `gh api`), never the community mirrors/vendor blogs. Key findings that shape M14: (1) there are THREE feed surfaces, not one - ACP/OpenAI ChatGPT flat feed (in production, 15 strict required fields; THE lint target), the ACP Product Feeds RFC (Status: Proposal/unreleased, minimal MUSTs, nested shape; advisory only), and UCP which is an API catalog capability (search/lookup over REST/MCP/A2A), NOT a static feed - its concrete feed surface is Google Merchant Center product data + a `native_commerce` eligibility attribute. (2) Debunked the widely-repeated "MPN required when GTIN absent" claim - NOT in the OpenAI spec (both optional; `brand` is the required identifier); verified against the source so M14 does not encode a phantom rule. (3) Pulled UCP required-field arrays straight from the JSON schemas (Product: id/title/description/price_range/variants; Variant: id/title/description/price). Six open questions parked for M17 re-verification (return_policy condition, is_ads_eligible scope, RFC release status, UCP schema churn, exact GMC product spec, GTIN/MPN drift). Reconciled against the Rails feed-quality logic (`ai-visibility-crawler` branch, `export/agent_readiness.rb` + `description_sanitizer.rb`) - PROTOCOL-NOTES.md section 7 is the merged M14 rule set: Rails contributes the completeness/quality checks (thin/misformatted description via the shared 5000-char sanitizer, q_and_a, the manual/llm auto-fix dimension, and a per-field graded feed score); the protocols contribute conformance + format validators + the protocol tag; two severity conflicts resolved (brand = error since ACP requires it though Rails treats it as llm-fixable; gtin = info/advisory since ACP makes it optional though Rails flags it as a gap). Deferred to M14: transcribing the full Google Merchant Center product spec. `PROTOCOL-NOTES.md` at repo root alongside `METHODOLOGY.md`.

### [ ] M14 - lint-feed (ACP + UCP) - DEFERRED to launch #2

Owner: setup · PR: (M14) · needs M2 + M13

> Built 2026-07-16 (module + CLI command), then **removed from the launch #1
> build** on 2026-07-17 (scope revision). Deleted: `core/lintfeed/`,
> `cli/lintfeed.ts`, `output/render-lintfeed.ts`, the M14 block in `types.ts`,
> and `test/fixtures/lintfeed/` (-44 tests, 352 -> 308). Recoverable from git
> at `faf351f`. The checked boxes and report below are history, not status.

- [x] rule engine (`{id, protocol, severity, field, test, message, docsUrl}`); 14-rule table ported from Rails `agent_readiness` + the M13 protocol spec (PROTOCOL-NOTES section 7)
- [x] per-product findings + feed-level score (per-field graded, Rails model) + per-protocol readiness verdict
- [x] Acceptance fixtures: clean / missing-GTIN / thin-desc / malformed XML; table-driven (`LINT_RULES` is the reviewable spec)
- Module report: `core/lintfeed/` - `parse.ts` (Google Shopping RSS/XML via cheerio + flat ACP JSON -> normalized `FeedProduct[]`; reads item children generically so namespaced `g:` tags need no selector escaping; splits "29.99 USD" into price+ISO-4217 currency; NEVER throws - malformed XML / bad JSON / CSV-TSV-not-yet-supported all surface as `parseErrors`, lesson #5). `rules.ts` - the `LINT_RULES` table IS the spec (14 pure rules; a non-engineer can read it); merges Rails quality checks (missing/thin<20/misformatted description, missing title/brand/image/gtin/q_and_a) with protocol conformance + format (gtin 8-14 digits, price currency, availability enum, HTTPS). The two reconciled severities from PROTOCOL-NOTES section 7 are encoded: `brand.missing` = ERROR (ACP-required), `gtin.missing` = INFO/advisory (ACP-optional, so a missing GTIN never lowers the score or blocks readiness - verified). `lint.ts` - pure `lintFeedContent`: per-product findings, per-field graded `feedScore` (info excluded so advisories don't tank it; description's 3 codes collapse to one field), per-protocol `readiness` verdict (errors block; warn/info don't; ready/nearly ready/not ready). `fetch.ts` - `lintFeedUrl` over an injected M2 `Fetcher` slice (fetch failure -> parseError, never throws); tests use a fake fetcher, zero network (hard rule #3). All output carries `schema_version` (rule #2). Independent of the LLM pipeline - imports only `../types` + `../fetcher`, never engines/scoring. Fixtures in `test/fixtures/lintfeed/`. 24 new tests (308->332); verified end-to-end on the built module across all four fixtures + the fetch path. Deferred: CSV/TSV parsing (honest parseError for now), the `lint-feed <url>` CLI command (M11-style thin wrapper, lands with M12/CLI work), and the full Google Merchant Center product spec for UCP-Google rules (M13 open question, needs M17 source pull).

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

### [x] M8 - Output data contract — ON THE CRITICAL PATH

Owner: setup · PR: (M8) · needs M7 + M3

- [x] `--json` stable envelope; snapshots to `.optifeed/snapshots/`; `diff(a,b)`; `--fail-under`
- [x] Acceptance: JSON schema snapshot test (break→bump), diff golden incl. changed-prompt-set
- Module report: `core/output` grew the M8 data contract (M9 renderer seed stays). `envelope.ts` - `VisibilityEnvelope` (THE stable shape every consumer reads) + pure `buildEnvelope` wrapping the M7 `ScoreReport` (headline `score`, per-engine, SoV, sources, per-answer mentions), the M4 profile, the raw M6 `answers` (evidence M9 renders - carried so renderers never re-derive), M3 `auditFindings` (surfaced as `findings`, never a competing audit score - rule #6), and run honesty (`costCapped`/`degraded`/`skippedEngines` attached only when set). `sampling` = `{nPrompts (distinct prompts), nAnswers, judged, varianceNote}`; `VARIANCE_NOTE` is the single honest caveat constant. Timestamp injected (deterministic). `snapshot.ts` - injected `SnapshotFs` (adds `readdir` over the profile/query persist pattern); `saveSnapshot`→`<stateDir>/snapshots/<ISO>.json` with colons sanitized to `-` (Windows-safe, still lexically chronological); `loadSnapshot` validates + throws `SnapshotParseError` not clobber; `listSnapshots` sorted, missing-dir→`[]`. `diff.ts` - `diffEnvelopes(a,b)`→`SnapshotDiff` (headline `scoreDelta`, per-engine `scoreDelta`/`wonPrompts`/`lostPrompts` over engines in BOTH runs; prompt-level mention = brand in ANY answer to that prompt; `promptSetChanged` flag + won/lost restricted to the shared-prompt intersection so a regenerated/hand-edited pack is never mislabeled a win/loss). `failunder.ts` - pure `failUnder(envelope, threshold?)`→`{passed, exitCode (0/1), partial, reason}`; a cost-capped/degraded run is flagged `partial` with an honest note. Golden fixtures: `test/fixtures/output/{golden-envelope.json (built from the real scoring answers fixture - the schema snapshot; break→bump), golden-diff.json}`. Depends only on `../types` + `../scoring` shapes (no cli/mcp). 28 new tests (181→209); verified end-to-end on the real disk path (`nodeSnapshotFs`: save→list→round-trip→diff→fail-under). Deferred to M10/M11 wiring: the actual `check --json`/`--fail-under` CLI surface and audit-vs-check envelope selection.

---

## Wave 4 - orchestration + entrypoints (need M8)

### [x] M10 - Run orchestrator (`core/run`) — THE SEAM

Owner: setup · PR: (M10) · needs M3,M4,M5,M6,M7,M8

- [x] `runCheck(domain,opts)` wires the full pipeline + two-phase budget + snapshot; returns envelope (no render)
- [x] `runAudit(domain,opts)` zero-key path; injection points for adapters/JudgeClient/fetcher
- [x] Acceptance e2e (all mocked): audit-only, full check, `--yes`, mid-run `--max-cost` → `costCapped`
- Module report: `runCheck` (`core/run/check.ts`) is the seam - one function wiring discover (M4) + audit gather/build (M3) [run CONCURRENTLY, both fetch-only, fetcher cache dedupes - lesson #6] → resolveQueries (M5) → estimate + confirm gate → askAll (M6) → scoreAnswers (M7) → buildEnvelope (M8) → saveSnapshot. Returns `RunCheckResult {envelope?, aborted, snapshotPath?, notes}`; renders nothing (M9's job). Everything that spends or hits the network is injected (`fetcher`, `adapters`, `judge`, `guard`, `profileFs`/`queryFs`/`snapshotFs`, `now`, `confirm`), defaulting to real impls - so the 6 e2e tests drive the whole pipeline with mocks and zero network (hard rule #3). Two-phase budget honored end to end (discovery/query-gen authorize `setup`, ask/judge `main`); a shared `CostGuard` threads through all four spenders. **Honesty assembled from ALL THREE independent signals** (M8 review lesson #1): `costCapped` (guard), `skippedEngines` (askAll), `degraded` (profile) - surfaced upward, never hidden (rule #6). Confirmation gate is bypassable (`--yes`) and only fires when a `confirm` callback is injected (agents/CI stay non-interactive - hard rule #8); declining returns `aborted:true` with no spend, no snapshot. Partial never throws: a cap returns partial answers + `costCapped`. `runAudit` kept as the seeded zero-key path (M3 only, returns `AuditReport`; audit's 0-100 stays separate from the check envelope - rule #6). Estimate is best-effort (`priceRun` returns undefined for an unpriced model or no judge; the guard still caps). Depends only on other modules' barrels (`../discovery`, `../queries`, `../engines`, `../scoring`, `../audit`, `../output`, `../costs`) - no cli/mcp import. 6 new tests (220→226); verified end-to-end on the real disk path (node fs + real fetcher: snapshot persists + reloads, audit surfaced a GPTBot block, degraded path). Deferred to M11: the `check`/`audit` commands (thin wrappers) and the interactive `confirm` implementation.

### [x] M9 - Output renderers (can land after M10)

Owner: setup · PR: (M9) · needs M8

- [x] terminal renderer (landing output = spec; picocolors only)
- [x] self-contained HTML report (dark theme, evidence sections, agency header); footer CTA constant
- [x] Acceptance: HTML zero external requests; consumes only M8 envelope
- Module report: `renderCheckText` (terminal) + `renderCheckHtml` (HTML) over the M8 `VisibilityEnvelope`, consuming it only (no re-derive). Terminal: headline AI Visibility Score, the honest sampling caveat (`varianceNote` + a grammatical `samplingLine`), per-engine lines (grounded vs parametric shown separately - copy rule), share of voice with a `(you)` marker, warn/error findings (info hidden in the landing view), a `Run notes` block surfacing honesty (costCapped/skippedEngines/degraded via the shared `honestyNotes`, rule #6), and the report path. Color is via **picocolors** (M9's owned dep, added) and fully optional - `{color:false}` yields ANSI-free output for capture/`--json`. HTML: one self-contained file (inline `<style>`, dark theme, agency header brand+domain+date, per-engine/SoV/findings tables, `Run notes`, raw answers as evidence behind `<details>`), **zero external resource loads** (no script/src/link/@import/remote url), and every piece of external text (brand, prompts, answers, citations, findings) HTML-escaped so untrusted LLM/web output cannot inject markup. **Single footer CTA**: extracted `FOOTER_CTA` into `footer.ts` (defined once); the seed's audit-specific "no engines queried" line became `AUDIT_ONLY_NOTE` in the audit body, so `check` and `audit` share one honest CTA (the old merged constant was false for a check run). Both renderers end with `FOOTER_CTA`; neither uses an em-dash. Depends only on `../types` + the M8 envelope; no cli/mcp. 15 new tests (226->239); verified by rendering the golden envelope (terminal eyeballed, HTML written + self-contained checks). Deviation: the exact landing-page example output / HTML mockup is external and unavailable - copy + layout are honest and structurally complete but to be reconciled against the messaging guide at M16.

### [~] M11 - CLI assembly (after M10)

Owner: setup · PR: (M11) · thin over M10 + M9

- [~] commands: `audit` [x] `check` [x] `diff` [x] `sources` [x] `queries` [x] `config` [x] · `compare` deferred (fuzzy - competitor-focused view overlaps `check`; needs design); `mcp` (M15) lands with its module; `lint-feed` (M14) and `shopping` (M12) deferred to launch #2 - `lint-feed` shipped 2026-07-16 and was removed 2026-07-17 (scope revision)
- [x] **A run with ZERO answers reported a confident `score: 0` (found + FIXED 2026-07-17, rule #6).** Fixed: `compositeScore` returns `number | null` (null when nothing was measured, replacing `totalWeight === 0 ? 0`), `score` is nullable on `ScoreReport` + `VisibilityEnvelope`, `isPartialRun` counts a null score as partial, `failUnder` never passes an unassessed run, `diffEnvelopes` returns a null `scoreDelta` rather than inventing one, and both renderers say "not assessed" (the terminal also drops the variance note, which described a score that did not exist). `schema_version` 0.1 -> 0.2 with all four goldens updated (hard rule #2). Verified live both ways: a broken key now prints "not assessed"/persists `score: null`, while a healthy run still reports a real 0/100 over 6 answers.
- [x] `check` exited **0** when the run measured nothing (found + FIXED 2026-07-17). Fixed with the `--fail-under` wiring below - they were the same missing call site.
- [x] Stray positional arguments now fail loudly (found + FIXED 2026-07-17). `check <domain> file.html` (a flag npm swallowed - the `--report` value left bare) used to hit commander's raw `process.exit` with a generic "too many arguments". `check`/`audit` now `allowExcessArguments(true)` and call a shared `rejectStrayArgs`, which routes an injectable error through the runtime (testable, keeps `--json` clean), names the offending token, points at `--report`, and explains the `npm run dev --` gotcha - before any spend. README documents the `--` requirement for `npm run dev`.
- [x] **Judge selection by PRICE - RULE REPLACED, MEASURED 2026-07-20.** The price rule is gone: `resolveJudgeModel` now ranks candidates by `JUDGE_PREFERENCE` (measured competitor recall), with cheapest-wins kept only as a tie-break for an UNRANKED model, so adding an engine degrades to the old behavior for that engine alone. Measured through the real discovery path on the doremusic Turkish-retailer task, ground truth verified on the web, 3 trials each: `gpt-5.4` 4/4 verified rivals and stable, `gemini-flash-latest` 4/4 and stable, **`claude-sonnet-5` 0 verified with ZERO overlap between its own three runs** - it invented a fresh plausible list every time and never returned Zuhal Müzik, the market leader the other two ranked first every run. **The headline: price is ANTI-correlated with quality** - sonnet-5 is the most expensive candidate ($3/$15) and the only fabricator, which kills "cheap = risky, expensive = safe" in both directions and is why the fix had to be a measured ranking rather than another price nudge. Order: gpt-5.4 (measured twice, no free-tier rate-limit history) > gemini-flash-latest (tied on recall, cheaper) > claude-sonnet-5 > sonar (bills per search; a search-billed model is a poor parametric-recall judge). Rule #6 companion: a measured-poor judge now carries a `qualityWarning` that follows the MODEL, not the selection path - so pinning `--judge claude-sonnet-5` does not buy silence - surfaced by `check` (stderr, so `--json` stays clean), both MCP dep paths, and `config`. Cost of the measurement: $0.0147. +9 tests (433 -> 442). Verified live on the built CLI for all three key combinations.
- [ ] **Competitor discovery returns the brand ITSELF under variant spellings** (found 2026-07-20 during the judge measurement). `gpt-5.4` returned "Dore Müzik" and "Do Re Müzik Market", `gemini-flash-latest` returned "Do Re Mi Müzik" - all doremusic. `buildPrompt` says "Do not include the brand itself" but passes only `brand: doremusic`; the profile's `aliases` never reach the prompt, and the post-filter matches the brand string exactly. So the brand lands in its own share-of-voice table as a rival, inflating a competitor that IS you. Small but real (rule #6 fake precision). Fix: pass aliases into the prompt AND filter competitors through the M7 Unicode-aware matcher rather than exact string equality.
- [ ] **Superseded, kept for the reasoning: judge selection by PRICE (2026-07-20, now closed above).** Anthropic's judge default `claude-haiku-4-5` ($1/$5) undercut openai's `gpt-5.4` ($2.50/$15), so an Anthropic key silently swapped the judge to a cheap tier; that specific downgrade is gone (anthropic now `claude-sonnet-5`, $3/$15, which sits just above gpt-5.4 - verified live on a 3-engine run). **But fixing the value did not fix the rule, and a Google key re-opens it immediately:** `gemini-flash-latest` ($1.50/$9.00) is cheaper than `gpt-5.4` per estimated judge call ($0.00195 vs $0.00325), so a 4-engine run live on 2026-07-20 reported `defaulting to the cheapest available (gemini-flash-latest)`. The judge does factual RECALL, where cheap models fabricate - the whole reason `gpt-5.4` was chosen by MEASUREMENT (0/10 -> 3/5 real Turkish rivals). Gemini Flash's competitor list looked plausible on that run (real feed vendors), but plausible is not measured. NOT redesigned on a guess: both the anthropic and the gemini outcomes are now pinned by tests so neither can drift silently. **Decide before launch:** rank judges by measured recall, or pin the judge default explicitly instead of deriving it from price. Note `sonar` is now the MOST expensive judge candidate ($0.0058) because its per-request search fee is finally modelled - a useful side effect, since a search-billed model is a poor judge.
- [x] **Non-OpenAI engine + judge models - VERIFIED AND FIXED 2026-07-20** (anthropic/gemini/perplexity keys obtained). The staleness was worse than suspected: `gemini-2.5-flash` returned **HTTP 404 "no longer available to new users"** - not stale like `gpt-4o`, DEAD, so every Gemini run was failing. Now `gemini-flash-latest` (Google's alias for the current Flash generation, resolved live to `gemini-3.5-flash`; cannot 404 out from under us, same reasoning as `-chat-latest`). The dead id was hardcoded in TWO places - the provider spec AND `DEFAULT_JUDGE_MODELS` - and fixing only the spec still left Gemini-judged runs failing on setup calls, caught live not by tests; a structural guard test now pins every spec default and judge default against `MODEL_PRICING`. Anthropic moved `claude-haiku-4-5` -> `claude-sonnet-5` (the cheap tier was the same validity gap as `gpt-4o-mini`: nobody chats with haiku). Perplexity `sonar` confirmed correct. Prices re-verified from official sheets; the apples-to-oranges concern is resolved - all four engines now name the tier real users get.
- [ ] Competitor QUALITY in non-English markets is weak (found 2026-07-17, after the locale fix). With `locale: tr` now reaching the judge, `www.do-re.com.tr` returns Turkish names instead of US chains - but the list is mixed: "Müzik Aletleri" is the common noun "musical instruments", not a brand, and Zuhal Müzik (the obvious real rival) is absent. The plumbing is fixed; `gpt-4o-mini` simply does not know Turkish retailers well. This is a judge-quality issue, not a wiring one - consider a stronger judge or a grounded competitor call, and re-check at the M17 smoke test on a non-English domain.
- [ ] For RETAIL brands the share-of-voice axis is structurally mismatched (found 2026-07-17). `doremusic` is a retailer, so buyer prompts like "2026 için en iyi akustik piyanolar hangileri?" elicit MANUFACTURERS - across 20 Turkish answers: Yamaha 9, Kawai 4, Roland 4, Fender 4, Casio 2 - never rival retailers. So even with correct Turkish competitors, a retailer scores 0 and learns little: the answers simply are not about shops. Retailers are a core segment, so decide before launch whether retail brands need retailer-seeking prompts ("Türkiye'de piyano nereden alınır?") and/or a manufacturer-vs-retailer competitor axis. Product decision, not a bug.
- [x] **`--grounded` flag WIRED 2026-07-18** (was: no flag set `mode`, so the grounded variants were unreachable - openai Responses/`web_search` and gemini grounding were dead code at runtime; third build-without-a-call-site after `CostGuard.authorize` and `failUnder`). Surface chosen: a single `--grounded` boolean on `check` (over per-engine config or run-both-and-merge - the simplest honest thing; per-engine mode can follow if asked). `flags.grounded` sets `runCheck` `opts.mode: 'grounded'`, which the existing plumbing already threads to every adapter. **Correctness fix in the same change:** the adapter now consults `supportsGrounded` (a field that existed on the openai/gemini specs but was NEVER read - a fetch-and-discard, lesson #7): a requested `grounded` mode only takes effect where the provider can actually ground (a `supportsGrounded` spec, or a natively grounded engine like perplexity); otherwise it falls back to the spec's native `kind`. So under `--grounded` with an anthropic key, anthropic's answer is honestly tagged `parametric` (no web search here) instead of being mislabelled grounded - which would be fake precision and would wrongly earn the 1.5x grounded scoring weight (rule #6). +2 tests (adapter no-mislabel; CLI flag reaches the adapter), 336 -> 338. Verified: `check --help` lists the flag; a `--grounded` run parses cleanly to the key guard. **Still unverified live against a real grounded engine call in a full `check`** (only an OpenAI key exists; the grounded PARSER itself was proven live 2026-07-17) - fold into the M17 smoke test.
- [x] **`--fail-under <n>` on `check` - WIRED 2026-07-17** (was: built at M8, tested, exported, and never called - the flag did not exist, so nothing ever gated on score; review lesson #3's third instance after `CostGuard.authorize`). Now a real commander option over `failUnder()`. Semantics: the gate reason always goes to STDERR so `--json` stdout stays pure; it is printed only when a threshold was given or the gate fails, so a healthy ungated run stays quiet; the exit code is only ever RAISED, never reset, so an upstream failure cannot be masked. A not-assessed run (score null) exits 1 with no threshold set - "nothing was measured" is not a threshold judgement. Verified live on all four paths: score 0 + `--fail-under 50` -> exit 1 with the reason; no threshold -> exit 0 and silent; bad key -> exit 1 + "not assessed"; `--json` + failing gate -> stdout still parses, reason on stderr.
- [x] all interactive prompts bypassable (`--yes` + flags); ship `audit` first
- [x] Acceptance e2e mocked: audit no-key, check 1-key, full, clean `--json` (no ANSI)
- Module report: `check <domain>` is the M11 headline - THIN over `runCheck` (M10) then an M9 renderer (hard rule #1: no orchestration in cli/). Flags: `--yes`, `--json` (clean envelope, no ANSI), `--report <file>` (HTML), `--quick` (8 prompts), `--engines a,b`, `--max-cost`/`--max-setup-cost` (CostGuard caps), `--refresh`/`--regenerate`/`--brand`/`--category`/`--queries`. Introduced a `Runtime` seam (`cli/runtime.ts`): every process effect (stdout/stderr, env, cwd, home, isTTY, clock, writeFile, fetcher) plus a `checkDeps` override behind one injectable object, so the 6 command e2e tests run with no process globals and no network. `defaultCheckDeps` builds the concrete deps (adapters from env, judge via `resolveJudgeModel` cheapest+notice → `createJudgeClient`, guard from cost flags, node fs, and a confirm gate that aborts off a TTY - agents pass `--yes`, hard rule #8). No-key `check` prints guidance to run `audit` and exits 1. `audit` now takes an injected fetcher via the runtime (offline-testable). Added `renderCheckJson` (M9). Deps added (M11-owned): `@inquirer/prompts` (lazy-imported inside the confirm gate). 6 new tests (239→245); verified the built CLI live: `--version`, `--help` (both commands), no-key `check` guidance+exit 1, and a real zero-key `audit example.com` over the network. Deferred to a follow-up: `compare`/`sources`/`queries`/`diff`/`config` (plus a `diff` renderer M9 did not build), and live `check` verification with a real key (M17 smoke test).
- Follow-up (2026-07-16): shipped `lint-feed <url>`, the M14 CLI surface that M14 deferred (M12 cross-references it, so it lands first). THIN over `lintFeedUrl` + a NEW M9 renderer (`render-lintfeed.ts`: `renderFeedLintText`/`renderFeedLintJson`), no lint logic in `cli/` (rule #1); zero-key, zero-spend. Exit code: non-zero ONLY when the feed could not be assessed (`feedScore === null` - unfetchable/malformed/empty), never on findings alone - reporting is not gating, consistent with `--fail-under` being the explicit opt-in gate. Renderer carries M14's honesty forward (rule #6): an unassessed feed shows "not assessed", never a fabricated 0, and never "no findings" (which would read as a pass); parse errors (incl. the truncation flag) always surface as notes. +13 tests (336->352, 9 renderer + 4 CLI). Live-verified on the built CLI against all four fixtures over a local HTTP server (real fetcher path): missing-gtin 100/100 + info-only (gtin advisory confirmed not to lower the score), thin-desc 87/100 warn, malformed -> "not assessed" + exit 1, 404 -> honest fetch note + exit 1, clean `--json` schema_version 0.1. The live run caught 3 copy defects the unit tests missed (fixed test-first): "2 advisorys" pluralization, a duplicated "not assessed (not assessed)" readiness line, and "No findings" claimed over an unassessed feed. README moved `lint-feed` from the roadmap into present-tense shipped capability (copy rules). Deferred: CSV/TSV feeds (honest parseError, M14's gap), a local-file path argument (plan scopes the command to `<url>`; M12 owns `--feed`), and a `--fail-on <severity>` gating flag if CI users ask.
- Follow-up (2026-07-16): built the four read-only inspect commands - `diff`, `sources`, `queries`, `config` - in `cli/inspect.ts`, each THIN over existing core (no spend). `diff <domain>` compares the two most recent snapshots (`listSnapshots`/`loadSnapshot`/`diffEnvelopes`) through a NEW M9 diff renderer (`render-diff.ts`: `renderDiffText`/`renderDiffJson`, honest about the promptSetChanged/engineSetChanged/partial caveats, single footer CTA). `sources <domain>` renders cited domains + share of voice from the latest snapshot via a new `renderSourcesText` (honest empty state when a parametric-only run cited nothing). `queries <domain>` prints/`--export`s the persisted pack (`toYaml`). `config` shows engine-key presence (never the value - rule #4), the resolved judge model, and the state dir. `Runtime` gained `snapshotFs`/`queryFs` (mirroring `fetcher`) so all four test with an in-memory fs and zero disk. 20 new tests (279→299; the validation-helper pass took 269→279 separately); verified all four live against the built CLI. Still deferred: `compare` (design first) and live `check` with a real key (M17).

### [ ] M12 - Shopping beta (after M10)

Owner: ___ · PR: ___

- [ ] `shopify.ts` (`/products.json`) + `feed.ts` (Google XML/CSV) → `ProductEntity[]`
- [ ] sampler (category clustering, top-N, cap 20 SKUs); shopping query pack
- [ ] reuse M10 (catalog entity source); `SkuReport`; cross-ref M14 findings
- [ ] Acceptance: fixture catalog + feeds; seeded sampling determinism; graceful non-Shopify message
- [ ] OUT of beta scope: VTEX/Woo, crawl discovery, full-catalog

---

## Wave 5 - distribution + release

### [x] M15 - MCP server

Owner: setup · PR: (M15) · thin over M10 (owns final tool names)

- [x] tools: check_visibility / audit_store / generate_buyer_queries / get_snapshot_diff (launch #1 4-tool set). `compare_competitors` DEFERRED to launch #2 with the CLI `compare` view (M11 parked it as "needs design"); `shopping_check` + `lint_feed` are launch #2 (M12/M14). The 4 final tool names are now authoritative.
- [x] stdio + official SDK (`@modelcontextprotocol/sdk`, low-level `Server` + raw JSON-Schema, no zod); non-interactive semantics (`yes:true`, no confirm gate, default $0.50 cap + `max_cost` override, cap -> partial not throw); agent-written tool descriptions (when-to-use + cost hints); progress notifications wired to `runCheck`'s `ProgressEvent`s (real `done/total` fraction, only when the client sends a `progressToken`); snapshot path returned so the agent can reference the on-disk report.
- [x] Acceptance: MCP-over-stdio integration test (in-memory transport, `initialize` -> `list_tools` -> `audit_store` over a mocked fetcher, zero network); tool JSON schemas snapshot-tested; 2 failure-mode tests (no-key `check_visibility` -> honest isError; `get_snapshot_diff` <2 snapshots -> honest note, no fabricated diff). Live-verified over real stdio: `initialize` + `tools/list` return the 4 tools, stderr clean of protocol pollution.
- Module report: `src/mcp/` is 4 thin files - `index.ts` (stdio entrypoint `optifeed-mcp`), `server.ts` (`createServer(ctx)` registers the 4 tools over the low-level SDK), `tools.ts` (`TOOL_SPECS` + `callTool` dispatch, thin over `core/run` + `core/output` renderers), `deps.ts` (`ToolContext` + `defaultToolContext`, non-interactive dep construction). Two shared orchestration pieces were extracted into `core/run` first so `mcp/` never imports `cli/` (hard rule #1): `buildCheckDeps` (the judge+adapter+fs wiring the CLI already did - `cli/check.ts` now delegates to it, behavior pinned by M11's tests) and `runGenerateQueries` (discover -> resolveQueries, the front half of `runCheck`; the CLI `queries` command is read-only so this was genuinely new). Every tool payload carries `schema_version` (rule #2) and all honesty flags ride the envelope (rule #6). Two code-review fixes applied test-first: an all-invalid `engines` array now errors instead of silently billing every engine (mirrors the CLI `--engines` guard - a money bug), and progress reports a real monotonic fraction from the ask `done/total` instead of a hardcoded 0.5. New dep `@modelcontextprotocol/sdk` (pre-authorized). Still unverified live: a real multi-engine `check_visibility` end-to-end (only the audit path and the stdio handshake were exercised without keys) - folds into the M17 smoke test. Follow-ups logged from the end-of-module review (not blocking launch #1): (1) `check_visibility` has no `grounded`/`mode` param, so MCP agents cannot reach the CLI's `--grounded` flag - a conscious parity gap, add if asked. (2) `domain` is now validated at the MCP tool boundary (`isPlausibleDomain`), but the underlying `resolveStateDir` still joins `domain` into a path unvalidated - harden it in `core` so the CLI benefits too. (3) MCP writes state under HOME while the CLI prefers `<cwd>/.optifeed`, so `get_snapshot_diff` over MCP does not see CLI-written snapshots (documented deliberate choice in `mcp/index.ts`); revisit if agents and humans need shared per-brand history.

### [x] M16 - Agent surfaces + README (after M11/M15)

Owner: setup · PR: (M16) · renames the product to Optifeed Radar

- [x] `SKILL.md` (`skills/optifeed-radar/`, ClawHub + plugin-bundled) · `.claude-plugin/plugin.json` manifest (stdio MCP + `skills/`) · `ai-context/` (claude-project / chatgpt-custom-gpt / cursor.mdc / windsurf)
- [x] README rewrite: MIT badge (npm/build/stars badges deferred to launch, noted honestly), 60-second setup, per-client MCP config blocks, tools + cost table, FAQ, directory-listing copy, "what this does NOT do"
- [x] Acceptance: automated copy-lint (`test/copy/`) enforces the unambiguous messaging rules over every surface; every README config snippet `JSON.parse`d; MCP stdio handshake live-verified to echo `serverInfo.name = optifeed-radar`
- Module report: renamed the npm package + CLI bin `optifeed-visibility -> optifeed-radar` (product name "Optifeed Radar"; brand token "Optifeed" unchanged). The rename surface was wider than first scoped: besides `package.json` name/bin and the commander program name, it also covered the MCP handshake identity (`src/mcp/server.ts`) and the crawler User-Agent (`src/core/fetcher/fetcher.ts` + 2 fetcher tests) and `test/cli.test.ts`. The MCP bin (`optifeed-mcp`) and `.optifeed/` state dir are unchanged. Version fields left as-is (`package.json` `0.0.0` vs the MCP identity's `0.1.0`) - reconcile at M17. Surfaces: one canonical skill at `skills/optifeed-radar/SKILL.md` (a directory the plugin loader bundles via `"skills": "./skills/"` and ClawHub ingests standalone; refines the design spec's "repo root" wording), a `.claude-plugin/plugin.json` wiring the stdio MCP server (`node ${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js`), and four per-platform `ai-context/` files. README is pre-release honest: the clone+build path leads (present-true), `npx`/npm invocation documented but marked pending until M17 publishes. Failure-mode coverage is the copy-lint: a pure `findMessagingViolations()` helper (`test/copy/messaging-rules.ts`, `String.includes` only - no regex, per the known hook conflict) with red/green unit tests over known-bad inputs (em-dash, `OptiFeed` mis-casing, free-vs-paid framing, present-tense Shopping, missing footer), plus an integration pass asserting zero violations across all seven surfaces and `JSON.parse` over every README json block. 398 tests (was 382). Not machine-checked (left to the manual pre-publish checklist): bare "agents" vs "AI agents", HN-survivable voice, grounded-vs-parametric phrasing. M17 must flip npm/npx copy to present tense, add the launch badges (npm/build/stars, once the repo slug + published package exist), file the directory-listing PRs, and reconcile the version fields. Cross-repo: the docs-repo `dev-plan.md` Global Decision package name updated to `optifeed-radar`.

### [ ] M17 - Release engineering + launch QA

Owner: ___ · PR: ___

- [x] **npm publish workflow + release docs DONE 2026-07-22.** `.github/workflows/release.yml` is TAG-DRIVEN (`v*` push, plus `workflow_dispatch` from a tag) so a merge to main can never publish by accident; it re-runs the whole gate (`npm ci` -> `check` -> `format:check` -> `build`) against the tree being packed rather than trusting the branch's CI run, reviews `npm pack --dry-run`, and publishes with `--provenance` (paired with the `id-token: write` permission it requires - the two are useless apart, so a test asserts BOTH, the same "enforcement wired at the call site" shape as lesson #3). New `scripts/verify-release-tag.mjs` closes the gap that npm publishes whatever `package.json` says regardless of the tag: a `v0.2.0` tag over a 0.1.0 manifest would republish the old version AND attach a provenance attestation pointing at the wrong commit. Verified all three paths (match -> 0, mismatch -> 1, non-tag ref -> 1). The workflow passes `github.ref_name` through `env`, never interpolated into the shell. `CHANGELOG.md` (Keep a Changelog + the 5-step release recipe, and the standing rule that a serialized-format change bumps `schema_version` and a scoring change is called out because scores are only comparable within one method) and `SECURITY.md` (private reporting; what the tool does with keys - env only, per-provider, never logged/persisted/sent to any Optifeed service, `config` shows presence not value; untrusted-content handling). No email address invented for the security contact - GitHub private reporting only, add an address when one exists. Both docs joined the copy-lint surface list (banned-substring + roadmap gates; no footer CTA, they are not reports).
- [x] **Version reconciled 2026-07-22** (the M16 hand-off item). `package.json` 0.0.0 -> **0.1.0**, and the MCP handshake no longer hardcodes its own copy: new `core/version.ts` `getVersion()` is the single source, re-exported by `cli/index.ts` (which previously owned the fs read) and consumed by `mcp/server.ts`. The test is a real guard, not a tautology - **mutation-checked** by restoring the hardcoded `'0.1.0'` and moving the manifest to 9.9.9, which turns it red. Live: `node dist/cli/index.js --version` -> 0.1.0 and a real stdio `initialize` echoes `serverInfo.version: 0.1.0`.
- [x] **`--max-cost` honesty carried into `--help` 2026-07-22** (the open "document it before launch" item; the README already said it). The flag's help called it a `hard cap on total spend` - a ceiling the guard cannot deliver, since a call's cost is unknown until it returns (rule #6). Now: capped, checked before every call, overshoot bounded by one unmeasured call per engine and always reported. Pinned by a test that fails on the phrase "hard cap" anywhere in `check --help`.
- [x] **`.env` auto-load DONE 2026-07-22** (launch-QA usability: the documented setup was `set -a; . ./.env; set +a`, which is shell-specific and easy to get wrong). `core/env-file.ts` `loadEnvFile()` wraps Node's built-in `process.loadEnvFile` - **no dependency added**, and the precedence is Node's, not re-implemented: a variable already in the environment is left alone, so a key exported for one run beats a stale `.env` (verified live, `sk-from-shell` wins over `sk-from-dotenv`). Called from `defaultRuntime()` BEFORE `process.env` is read, so engine detection sees the file's keys. Graceful on every path (lesson #5): no `.env` -> silent no-op; unreadable -> a reason, never a throw; Node older than 20.12 (no `process.loadEnvFile`) -> an honest reason naming the version, not a silent behavior difference. Rule #4 holds: the failure reason deliberately omits the thrown error, which can quote the offending LINE (a key); only paths are ever printed. Two surfaces report it: `config` names the file the keys came from, and the no-key `check` guidance now distinguishes "you set no keys" from "you set keys I could not read" - the two look identical from the user's side otherwise. The unreadable-`.env` test uses a DIRECTORY named `.env` rather than `chmod 000`, since the new Windows CI leg cannot express an unreadable file. +10 tests (504 -> 514); live-verified on the built binary for all four states (loaded / absent / broken / shell-wins).
- [x] **CI matrix DONE 2026-07-22** - ubuntu/macOS/Windows x Node 20/22, `fail-fast: false`. Windows earns its slot: the CLI resolves state paths from cwd and HOME. `format:check` runs on ubuntu only (line endings differ on a Windows checkout, and a format gate is a single-platform concern). Not yet observed green on a real runner - it lands with this push.
- [x] **`ai-shopping` / `agentic-commerce` keywords: DECIDED 2026-07-20 - KEEP** (owner's call). They are forward-looking toward launch #2 rather than a claim about shipped capability. Everything else stays honest about it: README, `--help`, SKILL.md and the `ai-context/` files all keep SKU-level and product-feed checks in FUTURE tense with a waitlist link, and the copy-lint enforces that. The npm keyword list is therefore the only forward-looking surface.
- [x] **DONE 2026-07-22.** `npm run clean` (`node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"` - deliberately not `rm -rf`, since the CI matrix now includes Windows) runs first in `build`. Verified behaviorally: planted `dist/ghost/removed-module.js`, ran `npm run build`, ghost gone. `npm pack --dry-run` reviewed - 202 files, 166.5 kB: `dist/` + README + METHODOLOGY + CHANGELOG + SECURITY + LICENSE + package.json, and no `src/`, `test/`, `scripts/` or `.env`. Two `files` gaps found by the review and fixed: **METHODOLOGY.md was linked from the README but not shipped** (so the published npm page pointed at a file that was not in the tarball - a test now asserts every repo file the README references is in `files`), and CHANGELOG/SECURITY are not auto-included by npm as assumed. Original note: `tsc -p tsconfig.build.json` never removes stale output, and `files: ["dist"]` publishes whatever is there. Surfaced by the 2026-07-17 M14 removal: deleted modules stayed in `dist/` until a manual `rm -rf`, so a publish from a stale tree would ship code that is no longer in `src/` (here: deferred commerce code, at launch #1). Verified a clean rebuild emits none of it.
- [x] **Spend reporting DONE 2026-07-20.** A run now reports what it cost, in the report a human actually reads. **Sourced from the cost guard, NOT by summing answers** - the original plan said "cheap: the envelope already carries per-answer `costUsd`", but that would have under-reported every run, because discovery, query generation and the scoring judge all spend without producing an answer to sum. New `RunSpend {setupUsd, mainUsd, totalUsd}` on `types.ts`, `CostGuard.spendBreakdown`, optional `spend` on the envelope, and a shared `output/spend.ts` (`spendLine`) so the terminal and HTML renderers cannot drift (the same reason `variance.ts` exists). The setup/engine split is reported rather than a bare total because setup money is spent BEFORE the confirm gate, so a user tuning `--max-cost` needs to see where it went. Honesty: an absent figure renders as nothing at all, never `$0.0000` - the same rule that renders an unmeasured score as "not assessed" rather than 0. **Second gap found and fixed while wiring it: an ABORTED run reported no spend at all**, but discovery and query-gen bill before the confirm gate, so declining in order to avoid spending still cost money and the CLI said only "Aborted - no engines were queried"; `RunCheckResult.spend` is now populated on both abort paths and the CLI prints it when non-zero. Snapshot round-trip is pinned in both directions (with spend, and a pre-spend snapshot still loading) - the null-score change once made every not-assessed snapshot permanently unloadable in exactly this spot. Rides into `--json` and MCP automatically via the envelope. +15 tests (453 -> 468); verified on the built code that a recorded run prints `Run cost: $0.3060 (setup $0.0213, engines $0.2847)` in both renderers while an old snapshot prints no cost line and fabricates no zero.
- [x] **Spend reporting LIVE-VERIFIED at the smoke test 2026-07-20.** Four real runs, $2.3780 total; every run's engine-phase spend equalled the sum of its answers' `costUsd` to the cent (no under-reporting), and setup spend appeared where discovery/query-gen actually ran ($0.0061 / $0.0000 cached / $0.0060). The grounded run also exercised the cap live: `--max-cost 1.20` stopped at **$1.0866 under the cap** and reported `costCapped` plus `partial=gemini 7/8` with real counts - reserve-and-settle plus the honesty signals working together on real money.
- [x] **`searchesPerGroundedCall` now MEASURED, not guessed.** Live Gemini grounded, 7 calls: 4,2,3,4,6,3,2 (median 3, mean 3.43, max 6). Kept at 4 - just above the mean, not reaching for the tail. Those 24 searches cost $0.3360, **57% of Gemini's spend for that run**, confirming the fee is the dominant term and that token-only pricing under-reported that engine by more than 2x.
- [x] **FIXED 2026-07-22 (SCORING_VERSION 2 -> 3): the grounded premium is now earned by ACTUAL retrieval, not by requesting grounded mode.** The bug: on the live grounded run, 7 of 8 OpenAI answers had zero `fanoutQueries` AND zero citations - the model declined to search and answered from its weights - yet all 8 carried `kind: 'grounded'` and earned M7's full 1.5x composite weight (rule #6, fake precision). `kind` records the mode REQUESTED; a grounded-mode call is a request a model can decline. **Fix shape: a strict generalization, not a redefinition** - `weight = 1.0 + 0.5 * retrievalRate`, so an engine that retrieved on every answer still weighs 1.5, a parametric engine still weighs 1.0, and ONLY the mislabeled middle moves. Evidence it is a generalization: the checked-in scoring/envelope goldens re-scored to the SAME headline number (46), changing only `scoringVersion` and the new field. `answerRetrieved` reads queries-or-citations, but only for engines KNOWN to report that evidence (`RETRIEVAL_EVIDENCE_ENGINES` = openai/gemini/perplexity, verified live 2026-07-20); for any other engine the requested kind is trusted, since absent evidence there means "not reported", not "did not search" - a new provider degrades to the old behavior rather than being silently downgraded (the same default-safe shape as the judge-preference tie-break). Backward compatibility is explicit: a grounded `EngineScore` with no `retrievedAnswers` (every snapshot written before this) keeps the full premium, so re-scoring an old snapshot reproduces the number it reported - pinned by a test. **Honesty carried into the output, not just the math** (rule #6): a grounded engine that did not search on every answer now prints `searched in 1 of 8 answers` in BOTH renderers (shared `retrievalLine` in `output/variance.ts`, the same anti-drift reason `spendLine`/`varianceNote` live there), and the retrieval-variance marker no longer claims an engine "rewrites your prompt before searching" when it ran no search at all. METHODOLOGY.md updated: the composite formula, the worked example, the new "asking for grounded mode is not the same as searching" paragraph with the live 7-of-8 evidence, and the version-3 history note. +17 tests (514 -> 531). Verified end to end on the BUILT code: 8 openai answers with one retrieval + 7 gemini answers all retrieving -> `retrievedAnswers 1/8` and `7/7`, weights 1.0625 vs 1.5000, and the disclosure line rendered.
- [x] **Smoke-test script shipped** (`scripts/smoke-test.mjs`, an M17 deliverable). Shells out to the BUILT binary so it exercises the real user path (arg parsing, key detection, rendering, exit codes), not the library underneath. Has `--dry-run`, per-run `--max-cost` caps, prints the hard ceiling before spending and actual spend after, and flags both under-reporting and the grounded-without-searching case above. `scripts/**` is eslint-ignored (plain .mjs, outside the tsconfig project, excluded from `files` so it never publishes). **Fixed a flaw in the script itself:** its first version POOLED search counts across engines and reported a misleading "n=8" that was really 7 Gemini calls plus 1 OpenAI - the per-search fee is engine-specific, so counts are now reported per engine.
- [ ] **Timing data for the `npx` cold-run gate:** a full `check --quick` (8 prompts x 4 engines) took 47-51s parametric and 97s grounded; `audit` alone was 0.8-4.4s. The <60s target is about time to first output, which `audit` clears comfortably, but a grounded `check` does not finish inside it - decide what the gate actually promises before publishing.
- [ ] smoke-test script (3 real domains, prints cost); `npx` cold-run <60s; Win/macOS/Linux CI matrix. **Live-verification debt CLEARED 2026-07-20** (see the review-log entries): all four engines are fixture-pinned from real captured payloads and exercised end to end. A parametric 3-engine `check` ran at $0.29 (21 answers), and after billing was enabled a **`--grounded` 4-engine run** completed at **$0.85** (28 answers) - openai/gemini/perplexity grounded, anthropic honestly tagged `parametric` (the no-mislabel guard, live). Grounded costs roughly 3x parametric on the same prompt count; budget the smoke test accordingly. Remaining: the `npx` cold-run timing (the CI matrix landed 2026-07-22, see above; a cold `npx` in a clean container needs the package published first, so it is the last gate).
- [x] **Google Search grounding fee MODELLED 2026-07-20.** Billing unit verified against the official sheet first, and it is the favorable answer: **per individual SEARCH QUERY, not per request** ("A customer-submitted request to Gemini may result in one or more queries to Google Search. You will be charged for each individual search query performed"), so the count Gemini already reports as `webSearchQueries` -> `fanoutQueries` IS the billable multiplier - **recorded spend is exact, not assumed**. New `ModelPricing.perSearchUsd` ($0.014 on both gemini rows), kept distinct from `perRequestUsd` so Perplexity's flat per-call fee and Google's per-search fee can never stand in for one another. Scale check on the real captured grounded call: 3 searches = $0.042 against $0.034 of tokens, so **the fee exceeded the entire token cost and that call was under-reported ~2.2x**. Wired at all three sites in one change: `costOfCall` (4th arg, defaults 0 so every parametric caller is unchanged), the adapter's recorded cost (from the reported search count), and the runner's pre-call RESERVATION (gated on `supportsGrounded`, newly exposed on `EngineAdapter`, so an engine that cannot search is never reserved for one - the under-reservation shape that caused the 74% breach). `priceRun` now passes `grounded` so the confirm gate quotes the run being requested; it previously quoted a parametric price for a grounded run. `ESTIMATE_ASSUMPTIONS.searchesPerGroundedCall` = 4, one above the single real observation and **deliberately not padded further**: cap safety rests on reserve-and-settle plus the probe call, while this number drives the figure shown to the user, where padding talks people out of runs cheaper than quoted. Effect on a 20-prompt 4-engine estimate: $0.77 parametric -> $1.89 grounded. +10 tests (442 -> 453); the reservation test was mutation-checked (disabling the grounded branch turns it red).
- [ ] **Measure the real grounded search-query distribution at the smoke test.** `searchesPerGroundedCall` = 4 rests on n=1 (one captured call, 3 searches). Fanout varies with query complexity, so capture the counts across a real `--grounded` run and replace the assumption with a measured median. Note Google also grants a free grounding allowance (5,000 prompts/month at the time of writing), so a user inside it pays no fee at all - pricing it anyway is deliberate, an estimate must not under-report.
- [ ] 100-brand data-run script (budgeted) for the launch article
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
- 2026-07-15: end-of-wave workflow review of Wave 3 (M4/M5/M7), 22 agents
  (6 finder lenses + adversarial verify). 15 verified findings (1 refuted), all
  fixed test-first (+30 tests, 151→181). Headliners: `--brand/--category`
  flags no longer clobber a curated profile (load+merge); non-Latin brand /
  competitor detection fixed via a shared Unicode-aware matcher (`core/text.ts`)
  - CJK by substring, others by boundary - so 楽天 scores instead of silently
    0; LLM-JSON parsers hardened with a balanced-brace extractor (trailing prose
    no longer voids the parse); `loadProfile` now validates; fetch-failure no
    longer clobbers a good cached profile (degrades instead); `mergeProfile`
    preserves user `geo`; `ScoreReport` tagged with the scoring schema_version;
    sentiment handles negation; SoV dedupes brand==competitor; cost
    authorization estimates the real token budget (setup + judge phases).
- 2026-07-15: high-effort workflow review of M8 (output contract), 18 agents
  (4 finder lenses + adversarial verify). 10 findings; 7 fixed test-first
  (commit `63d8c15`, +11 tests, 209→220), 2 accepted by-design + 1 deferred.
  Fixes: `failUnder`/`diff` partiality now counts `skippedEngines` not just
  costCapped/degraded (shared `isPartialRun`, rule #6); `diff` gained
  `engineSetChanged` (a dropped engine no longer vanishes) + throws on a
  cross-domain diff; `loadSnapshot` rejects an incompatible `schema_version`
  by value (rule #2) and validates all required fields. Accepted: ISO-keyed
  snapshot overwrite (idempotent), diff direction (explicit via from/to).
- 2026-07-15: end-of-wave review of Wave 4 (M9/M10/M11), 21 agents (4 finder
  lenses + adversarial verify), plus a live `check` smoke against a real
  OpenAI key. 10 findings (1 refuted) + 1 live-smoke finding, all fixed
  test-first (commit `2c3047d`, +7 tests, 245→252). Money/honesty headliners:
  runCheck no longer spends when a consumer wires no `confirm` and omits `--yes`
  (aborts - protects the coming MCP entrypoint, rule #8); `--engines <typo>`
  now errors instead of silently billing every engine; `--report` write is
  best-effort and never throws away a paid run; `--json --report` writes both;
  the cost-cap note no longer claims "prompts not asked" when only the setup
  cap fired; the CLI now surfaces keyless engines as skipped (honest 1-of-4,
  found live). Cleanups: `--judge` option added (the notice pointed at a flag
  that did not exist), `ENGINE_ORDER` exported (3rd hardcoded engine list
  removed), confirm prose moved to stderr, `AUDIT_ONLY_NOTE` gained a test.
  Live smoke verified real cost accrual ($0.0024, dated model id
  `gpt-4o-mini-2024-07-18`), no key persisted to disk, real discovery, and
  audit findings merged. Deferred: test-helper dedup across cli/run tests;
  trim 0%-share-of-voice rows. Accepted: nothing outstanding.

- 2026-07-15: post-review fixes + UX from live `check` use (test-first, 252→269).
  (1) Cache served the wrong brand: `discover`/`resolveQueries` reused a cached
  profile/pack without a domain check, so a shared `.optifeed` served one brand's
  data for another - now a domain mismatch re-discovers (commit `864a89a`).
  (2) State dir domain-scoped to `<cwd>/.optifeed/<domain>` so multiple brands
  coexist per directory (`c3cc7cc`). (3) Live progress: `runCheck` emits phase
  `ProgressEvent`s (core emits data, never renders - rule #1), CLI renders a
  stderr spinner + per-prompt list, TTY-only and off under `--json` (`6abe2ad`).
  (4) Generated buyer prompts now must be self-contained - no dangling "this
  brand"/"these products" back-references (bit the Turkish pack); trust prompts
  name the brand (`9f47f63`). (5) Branded (trust) prompts scored apart as a
  `reputation` block (sentiment), kept OUT of the visibility score so it stays
  "surfaced unprompted" - M7/M8/M9 + optional envelope field, schema unchanged
  (`9be899d`). All five verified live against wefood.com.tr.

- 2026-07-16: high-effort workflow review of `21f0f94..HEAD` (the buyer-prompt/
  score/meta fixes + the validation-helper and M11-inspect-command work), 18
  agents (finder angles + adversarial verify). 9 verified findings (1 refuted),
  all fixed test-first (+ ~24 tests, 290→308). Headliners: (1) the score formula
  changed meaning while snapshots stayed `schema_version` 0.1, so `diff` reported
  methodology deltas as real regressions - added `SCORING_VERSION` (=2) to
  `ScoreReport`/envelope and a `scoringChanged` flag `diffEnvelopes` sets +
  `render-diff` warns on (decision: version-tag over a schema bump, keeps
  history). (2) coverage-aware position scored a mentioned-but-unranked answer as
  absent (0) - now earns a mid-list default (rank 4); METHODOLOGY updated. (3)
  `sources --json` dropped honesty flags - now carries costCapped/skipped/degraded
  (rule #6). (4) the OG case-insensitive fix stored the key as-authored while
  consumers read lowercase - key now normalized. (5) the validation helper's new
  schema-version throw aborted a run uncaught - introduced a distinct
  `SchemaVersionError` so cache loaders (`loadProfile`/`loadQueryPack`) recover
  and re-discover while parsers/historical snapshots still surface it. Cleanups:
  validator error text distinguishes absent vs mis-typed; `diff` loads its two
  snapshots concurrently; shared `renderShareOfVoice`/`renderNoteBlock` helpers
  de-duplicate three renderers. Refuted: a false alarm about the `config` judge
  line. Verified live against the built CLI (diff scoring-change warning; sources
  --json honesty).

- 2026-07-16: high-effort workflow review of M13+M14 (`8e66fb2..HEAD`), 16
  agents (4 finder lenses + adversarial verify). 8 verified findings (0
  refuted), ALL in the M14 lintfeed code (M13's notes drew none), all fixed
  test-first (+8 tests, 328->336). Honesty headliners (all rule #6): (1)
  `lintFeedUrl` dropped the fetcher's `truncated` flag - a size-capped feed was
  linted as complete; now surfaces a truncation parseError. (2) an unparseable/
  empty feed reported `feedScore 0` + "not ready" (fabricated precision over an
  unevaluated feed) - now `feedScore: number|null` = null + verdict "not
  assessed". (3) a UCP readiness verdict was emitted with ZERO UCP-specific
  rules ("UCP: ready" = false confidence) - readiness is now derived from the
  rule table, so only protocols with a specific rule are reported (just `acp`
  now; `ucp` auto-returns when its rules land). (4) `Math.round` could launder
  199/200-ready up to a "ready" 100 - now `Math.floor` so any error keeps it
  <100. Correctness: (5) `parseJson` wrapper-key lookup was case-sensitive
  (`{"Products":[...]}` read as 0 products) - now case-insensitive over
  products/items/entries. (6) `qanda.missing` read a fixed `q_and_a` key while
  JSON stores `qAndA` as `qanda` - now a separator-normalized lookup. Cleanups:
  bare "agents" in report messages -> "AI agents" (copy rule); removed the dead
  try/catch around the lenient `cheerio.load`. Verified on the built module
  (null score + acp-only readiness on malformed; truncation flag; capitalized
  wrapper).

- 2026-07-17: **first live smoke test of `check`** against a real engine
  (OpenAI; the other three have no keys yet). The full pipeline works
  end-to-end - see the `check` ships milestone for what was confirmed. It also
  found the bug the smoke test existed to find, plus two structural gaps:
  (1) **OpenAI grounded parsing was broken against the real API.** The parser
  read `output_text` and `citations` off the top level of `/v1/responses`, but
  BOTH are SDK conveniences that do not exist on the raw HTTP body. A live
  grounded call returned HTTP 200, billed ~8.2k input tokens, and yielded an
  EMPTY answer with no citations - silently, no throw. Real shape (fixture:
  `test/fixtures/engines/openai-grounded-real.json`, captured live): text at
  `output[] -> {type:'message'}.content[] -> {type:'output_text'}.text`;
  citations from that content's `url_citation` annotations. Fixed test-first
  (+1 test, 308->309); the same live call now returns real text + 6 citations.
  This is lesson #1 verbatim - the grounded path had NO test at all and its
  `ResponsesShape` type was written from imagination, so nothing contradicted
  it. Lesson reinforced: **a hand-written provider type is a guess until a real
  payload proves it.** (2) The grounded path is unreachable from the CLI
  anyway - no flag sets `mode` (logged under M11). (3) A run never reports what
  it spent (logged under M17).

- 2026-07-17: **fixed the zero-answer honesty bug, and it exposed that the M11
  e2e tests never ran the pipeline.** A run measuring nothing printed
  "0/100" and persisted `score: 0` with no honesty flag. Root cause was one
  expression - `compositeScore`'s `totalWeight === 0 ? 0 : ...` - and, worse,
  **a test asserting that fabricated 0 as correct** (`it('is 0 when there are
no engines')`), which locked the bug in. Now `number | null` end to end:
  nullable on `ScoreReport`/`VisibilityEnvelope`, `isPartialRun` treats null as
  partial (so no derived artifact relaunders it), `failUnder` never passes an
  unassessed run, `diffEnvelopes` yields a null `scoreDelta` instead of
  inventing one, both renderers say "not assessed". `schema_version` 0.1 -> 0.2
  - 4 goldens (rule #2); the pin test stays a hardcoded literal on purpose, so
    a bump can never be silent. +6 tests (318 -> 324).
    **The bigger find:** making the fabricated 0 impossible turned the `check`
    e2e tests red - and they were red for a REAL reason. `testRuntime` seeded
    `profile.json`/`queries.yml` at `/proj/.optifeed`, but the state dir became
    DOMAIN-SCOPED in c3cc7cc (`/proj/.optifeed/acme.example`), so the seeds were
    never found; `check` fell through to generation, the stub judge returned `{}`
    = zero queries, and the "mocked e2e" ran on **0 prompts, 0 answers, 0
    engines**. It passed because `typeof score === 'number'` was satisfied by the
    fabricated 0. So M11's "all mocked-e2e covered" was, for these tests,
    covering an empty run. Seeds now use the scoped path and the test asserts
    `answers`/`engines`/`nPrompts` are non-zero. Lesson: **a green e2e that only
    asserts the SHAPE of an output cannot tell you the pipeline ran** - assert
    the evidence (counts), not just types. Two more tests were rotted by the
    bump: several hardcoded `'0.2'` as their "incompatible version" example (now
    current), and one needed the CURRENT version to reach its missing-field path
  * it now interpolates `SCHEMA_VERSION`.

- 2026-07-17: **the measured model was wrong, and that invalidated the headline
  number.** `check` asked `gpt-4o-mini` - both the wrong TIER (nobody chats with
  mini) and the wrong GENERATION (`gpt-4o` is legacy; it is no longer even on
  OpenAI's price sheet, and ChatGPT serves GPT-5.x). The product claims to
  answer "does the AI your buyers use recommend you?", so measuring a cheap
  legacy model answered a question no buyer asked. Verified against the live
  `/v1/models` endpoint (the key exposes the full GPT-5 line incl.
  `gpt-5.3-chat-latest`, OpenAI's alias for what ChatGPT currently serves) and
  the official price sheet. Now: engine = `gpt-5.3-chat-latest`, judge =
  `gpt-5.4`, with GPT-5 pricing added (`lastUpdated` 2026-07-17 + source +
  the two caveats: the chat-latest price is inherited from a generic row, and
  the alias FLOATS). Cost moved as expected: a `--quick` run went $0.0024 ->
  $0.0926. Judge choice was measured, not assumed - on the Turkish competitor
  task `gpt-4o-mini` scored 0/10 real, `gpt-4o` 2/8, `gpt-5.4-mini` 1/8,
  `gpt-5.4` 3/5 with Zuhal Müzik / MyDukkan / Cangöz Müzik ranked FIRST. Live
  after the change, doremusic's competitor list is finally real. Two things the
  switch flushed out: (1) **GPT-5 models reject `max_tokens`**
  (unsupported_parameter -> HTTP 400) and require `max_completion_tokens`;
  legacy gpt-4o accepts both, so the new name is now used unconditionally
  (verified live across all four ids). (2) That 400 exposed the zero-answer
  honesty bug logged under M11 - the failed run still printed "0/100". Testing
  note: three tests broke on the default change purely because they asserted
  the DEFAULT's value while testing something else (parsing, the JudgeClient
  contract, configured-vs-echoed pricing). They now pin `model:` explicitly -
  a test should not re-target itself when a default moves.

- 2026-07-17: live test on a **Turkish** site (`www.do-re.com.tr`, a music
  retailer) - the first non-English run. What works: locale detection (`tr`,
  extracted from markup) and query generation, which produced genuinely
  idiomatic Turkish buyer prompts. Mention detection is correct too - the score
  of 0/15 is honest (every brand mention was in a branded prompt, which
  scoring excludes by design). Two bugs found and fixed test-first (+6 tests,
  309->315): (1) **`--quick` was silently ignored whenever a pack was cached.**
  `resolveQueries` returned the cached pack without ever reading `opts.count`,
  so a run asking for 8 prompts ran all 20 - 2.5x the requested cost, no
  warning. `count` is a cost control and must bind however the pack was
  obtained; `capPack` now truncates cached AND explicit-file packs, with a note
  (truncate, not regenerate: costs nothing and keeps prompts stable so `diff`
  stays valid). Verified live: 15 buyer prompts -> 6, with "using 8 of 20 saved
  prompts". (2) **Competitor discovery ignored locale.** The profile extracted
  `locale: tr` correctly but `buildPrompt` never received it, so a Turkish
  retailer got 8 US chains (Guitar Center, Sam Ash, Sweetwater...) - and ALL 8
  had zero mentions across 20 Turkish answers, making the entire share-of-voice
  table read 0%. Lesson #7 (fetch-and-discard) with teeth: the signal was
  extracted, stored, and dropped at the one call site that needed it. Verified
  live via `--refresh`: Turkish names now. Two follow-ups logged, NOT fixed:
  non-English competitor quality is still weak (a model limit, not wiring), and
  the retailer-vs-manufacturer share-of-voice mismatch (a product decision).
  Testing lesson worth keeping: **my first version of the locale test passed
  against the buggy code** - `toContain('tr')` matched "insTRuments" in the
  category and `/market/` matched the prompt's existing "map a market". A loose
  assertion is a false green; assert a distinctive marker
  (`Primary market (locale): tr`). The `discover` test helper also did
  `void prompt`, discarding the very thing that needed asserting - no test
  could have caught this bug.

- 2026-07-17: high-effort workflow review of this session's code
  (`faf351f..HEAD`, 6 commits: grounded-parser fix, locale + --quick, model
  defaults, null-score, --fail-under, stray-args). 4 finders + per-location
  adversarial verify; 3 verified findings (1 refuted), all fixed test-first
  (+4 tests, 331 -> 335). (1) CORRECTNESS, the serious one: the null-score
  change (0.2) made `saveSnapshot` WRITE `score: null`, but the loader's
  `validateEnvelope` still asserted `v.number(obj,'score')` - so every
  not-assessed snapshot the tool wrote was permanently UNLOADABLE, crashing
  `inspect`/`sources`/`diff` on that domain. Exactly the "honesty must
  propagate to every derived artifact" path the change was meant to cover, and
  the M8 lesson that a validator must vouch for the real type of every field a
  consumer reads. Added `validator.numberOrNull` (null valid, absent still a
  failure) and used it in the loader; verified live: `sources` now reads a
  null-score snapshot instead of throwing. (2) HONESTY: fixed `terminal.ts` to
  drop the variance note under a null score but missed `html.ts` - the HTML
  report printed "not assessed" then the variance note right below, claiming a
  score. (3) CLEANUP: `capPack`'s note told users to `pass --regenerate`, but
  on the explicit `--queries` file path resolveQueries returns before
  --regenerate is consulted, so the advice was dead (and an input file is not a
  "saved" pack); the note is now path-specific. Refuted (correctly, not a bug):
  `ResponsesShape.action` is declared+documented but not read yet - a
  deliberate, logged forward-hook for the M6 fanout follow-up, not dead code.
  Lesson banked: a type change that a runtime validator also guards needs the
  validator updated in the same commit - `tsc` cannot see hand-rolled
  validation, so it stayed green over an unloadable format.

- 2026-07-18: high-effort workflow review of the M5/M6/M7 fanout follow-ups
  (uncommitted `git diff HEAD`), 16 agents (4 finder lenses + per-location
  adversarial verify). 6 distinct verified findings (0 refuted), all fixed
  test-first (+8 tests, 344 -> 352). Two were correctness/honesty: (1) the query
  pack fill was quota BLOCKS (all best-of, then comparison, ...), which
  front-loads best-of - a cost-capped run (askAll stops in pack order) would then
  score almost entirely off best-of answers, skewing the headline number. Fixed
  with smooth weighted round-robin: best-of still over-represented but spread, so
  a truncated run stays balanced (SWRR happens to reproduce the original
  interleave, so the golden reverted to unchanged). (2) the retrieval-variance
  marker keyed on engine id alone, so a DEFAULT parametric openai/gemini run got
  a false "rewrites your prompt before searching" caveat though no search ran
  (rule #6) - now gated on `e.kind === 'grounded'` too. The rest: HTML report had
  no variance framing at all (parity gap - added, shared `output/variance.ts`);
  the judge token budget was pinned at 900 while the ask grew (weighted + buffer +
  paired variants), risking a truncated -> empty pack on verbose locales (now
  scales with the ask); "these engines"/"their scores" plural even for one engine
  (now singular/plural aware); and `fanoutQueries` was captured but unsurfaced
  (lesson #7 - now shown in the HTML evidence block when present). Verified live
  by rendering both a parametric (no marker) and grounded (marked, singular copy)
  envelope.

- 2026-07-19: high-effort workflow review of M15 (`922bc32..d6a4ec7`, the MCP
  stdio server), 18 agents (4 finder lenses + per-location adversarial verify).
  10 verified findings (2 refuted), all fixed test-first (+14 tests, 368 -> 382).
  Five were correctness in the MCP tool layer: (1) `check_visibility` appended a
  "Snapshot saved at ..." prose line to its text channel, so unlike the other 3
  tools `JSON.parse(content[0].text)` threw - now pure JSON, the note is a
  separate content block; (2) `defaultToolContext` built ONE fetcher for the
  whole server lifetime, and the fetcher cache is a permanent per-instance Map,
  so a long-lived stdio session served stale responses (a re-audit after a
  robots.txt fix saw the old result) and grew unbounded - now a fresh
  `newFetcher()` per tool invocation; (3) a non-array `engines` (bare string,
  object) fell through to "query every available engine", silently widening a
  run the agent meant to restrict - a string now coerces to one engine, any
  other mis-shape errors, never widens; (4) an empty `engines: []` hard-errored
  instead of meaning "no preference" (all available); (5) a stringified
  `max_cost: "0.10"` was dropped to the higher $0.50 default cap - now parses
  numeric strings. Five were cleanup/seam: `buildCheckDeps` built all four engine
  adapters a second time to pull out one judge (now `createEngineAdapters({only})`
  builds just the judge) and used a non-null `availableEngines[0]!` that would
  build a broken judge on an empty set (now an honest throw); the CLI/MCP engine
  parsing and the discover->resolveQueries composition were duplicated (extracted
  `selectEngines` and `discoverAndBuildQueries` into `core/run`); and
  `generate_buyer_queries` spread pack fields under the pack's own
  schema_version, mislabeling a non-QueryPack (rule #2) - now an envelope with
  the pack nested. Refuted (correctly): a missing setup sub-cap (setup calls are
  token-bounded to cents, cannot approach the cap) and a copy-pasted ISO-clock
  arrow (behaviorally identical). One backward-compatible cross-module add:
  `only?` on `core/engines/registry.ts`.

- 2026-07-20: **first live verification of the three unproven engines** (anthropic,
  gemini, perplexity keys obtained). The hand-written provider specs had never
  met a real payload; captured real responses are now fixtures
  (`test/fixtures/engines/{anthropic,gemini,perplexity}-real.json`). Two specs
  were already correct - **perplexity's top-level `citations` really does exist
  on the raw body** (the OpenAI "SDK convenience" trap did NOT generalize), and
  anthropic parses cleanly (its echoed id is DATED, `claude-haiku-4-5-20251001`,
  the lesson-#2 case the adapter already handles by pricing from the CONFIGURED
  id). Six real defects found, all fixed test-first (+15 tests, 398 -> 413):
  (1) **Gemini was entirely dead** - `gemini-2.5-flash` returns HTTP 404 "no
  longer available to new users". Not stale, DEAD. The id was hardcoded in TWO
  places (provider spec + `DEFAULT_JUDGE_MODELS`) and fixing only the spec left
  Gemini-judged runs failing on setup calls - **caught by the live run, not by
  the tests**. A structural guard test now pins every spec default AND judge
  default against `MODEL_PRICING`. Lesson: a model id with a second home is a
  second bug; grep for the value, do not trust the one call site you found.
  (2) **Gemini cost under-reported ~6x** - `thoughtsTokenCount` is billed at the
  output rate (official sheet says output "includes thinking tokens") but is
  reported in a SEPARATE field the parser ignored, and the priced rate was
  $0.30/$2.50 against an actual $1.50/$9.00. (3) **Perplexity cost under-reported
  7x** - a flat `request_cost` of $0.005 per search on top of tokens, unmodelled;
  `ModelPricing` gained `perRequestUsd`. The API self-reports the true figure in
  `usage.cost.total_cost`, which the test now asserts against. (4) **Gemini
  thinking starved capped calls** - Gemini budgets thinking and answer from ONE
  `maxOutputTokens` pool, so at the scoring judge's 60-token cap thinking ate 55
  and the answer came back as a single stray character (finishReason MAX_TOKENS);
  `thinkingBudget: 0` now applies whenever a caller caps tokens, while the ask
  path sends no cap and keeps thinking on (that is what a real user gets).
  (5) **Wrong Anthropic tier** - `claude-haiku-4-5` was the same validity gap as
  `gpt-4o-mini`; now `claude-sonnet-5`, which also resolved the judge-downgrade
  risk logged at M11. (6) Defensive: Gemini `parts[]` may carry `thought: true`
  reasoning parts, which the parser joined into the answer text - now filtered,
  so private reasoning is never scored as what the engine said.
  Methodology note worth keeping: **one claimed finding was wrong and was
  retracted** - an apparent "Gemini truncates measured answers" came from a
  synthetic 1024-token cap in the probe, not from the ask path (which sends no
  cap and returned 7000+ char answers). Reproduce against the REAL call path
  before believing a probe result.

- 2026-07-20: **fixed the silent-partial bug the engine verification exposed.**
  A live run had gemini answer **1 of 8** prompts (free-tier rate limiting); the
  engine was scored on that single sample, sat in the report beside engines with
  8, and the run carried **no honesty flag at all** - so `diff`, `--fail-under`,
  and the HTML report all read it as a complete measurement. Root cause in
  `runner.ts`: an engine was flagged only when EVERY call failed, and the
  `errors` array for the partial case was computed and then dropped on the floor
  (lesson #7, fetch-and-discard). Fixed as a FOURTH independent honesty signal,
  `partialEngines`, deliberately NOT folded into `skippedEngines` - the two mean
  different things (a skipped engine produced nothing; a partial engine produced
  real, scoreable answers) and collapsing them would have claimed gemini was
  skipped when it in fact contributed to the score. It carries counts
  (`attempted`/`answered`), not a boolean: "partial" without numbers hides HOW
  partial, which is the fake-precision problem rule #6 exists to prevent.
  Propagation was nearly free because `failUnder` and `diffEnvelopes` both route
  through the shared `isPartialRun` predicate rather than hand-rolling subsets -
  the M8 lesson working as designed - and both are now pinned by regression
  tests anyway. Verified against the REAL built code on a real envelope: clean
  run stays non-partial (no false positive), the flag survives the save->load
  round-trip (so `diff`/`sources`/`inspect` see it - the null-score change once
  made snapshots permanently unloadable exactly here), and both renderers print
  the counts. Also fixed a miniature of the same hazard: the `failunder` test
  helper typed its honesty param as a hardcoded three-flag subset, so a new
  signal could not even be passed to it - now derived from `RunHonesty`.
  **Not reproduced live post-fix**: gemini's free tier caps at 20 requests/day
  and testing exhausted it, so today every gemini call fails and lands in
  `skippedEngines` (total failure) rather than partial. Re-confirm the partial
  path at the M17 smoke test once billing is enabled.

- 2026-07-20 (later, after billing was enabled): **Gemini GROUNDED verified - the
  last never-executed provider shape.** Structurally the hand-written parser was
  right (`groundingChunks[].web.uri` exists), but it was reporting the wrong
  thing: **every citation URI is an opaque Google redirect**
  (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) and the real
  publisher lives in `web.title`. M7 derives cited domains via
  `new URL(u).hostname`, so on the live call all **16 citations collapsed to a
  single domain - Google's own infrastructure** - and the sources table showed
  that instead of the publishers. "Which sources does the AI cite about you" is
  a headline capability, so this was a wrong product output, not cosmetic; those
  signed redirects also expire, so persisting them rots the snapshot evidence.
  Fixed: prefer `web.title` when it is genuinely a hostname, else keep the uri
  (a working opaque link beats a fabricated one) - both branches tested.
  Also closed M6's logged gap by capturing Gemini's `webSearchQueries` as
  `fanoutQueries`, the same evidence OpenAI exposes via
  `web_search_call.action.queries` (it was sitting in the payload unread -
  lesson #7 again). Verified live on a `--grounded` 4-engine run: sources are
  real publishers (datafeedwatch.com, feedon.ai, marpipe.com, ...), zero
  `vertexaisearch` leakage, fanout queries captured, anthropic honestly tagged
  parametric. +4 tests (413 -> 418), $0.85 for the run.
  **Correction to the previous entry:** it claimed the M11 judge-downgrade risk
  was closed. It is not - fixing anthropic's VALUE did not fix the price-only
  RULE, and `gemini-flash-latest` ($1.50/$9.00) undercuts `gpt-5.4`, so the same
  live run reported `defaulting to the cheapest available (gemini-flash-latest)`.
  Re-opened in the M11 list with both outcomes pinned by tests. Lesson worth
  keeping: **fixing the instance is not fixing the rule** - when a selection
  policy produces a bad outcome, re-run the policy against every candidate
  rather than patching the one that bit.

- 2026-07-20: **high-effort workflow review of the two M17 engine-verification
  commits** (`38b0e38..HEAD`), 32 agents (5 finder lenses + per-finding
  adversarial verify). 15 verified findings (11 refuted), deduped to 8 distinct
  defects, ALL fixed test-first (+13 tests, 418 -> 426). Honesty headliners:
  (1) **`sources --json` silently dropped `partialEngines`** - that call site
  hand-rolled its own honesty projection and enumerated three flags, so the JSON
  and the TEXT rendering of the SAME snapshot disagreed about whether the run
  was partial, and its test asserted only the flags it already carried (a false
  green on the exact contract). Fixed by extracting `honestyFields(env)` in
  `core/output`: honesty is now PROJECTED, never enumerated, so the next signal
  is carried automatically. Share of voice is a cross-engine ratio, so a 1-of-8
  engine skews it harder than a fully skipped one. (2) **Cost-capped truncation
  produced no `partialEngines` entry and the error path reported a fabricated
  `attempted`.** Adapters fan out concurrently against ONE global `costCapped`
  flag, so engine A can answer 8/8 while engine B answers 1/8; gating the signal
  on errors alone missed that, leaving only a run-level cap note that names no
  engine. Worse, the reason blamed the first ERROR for prompts the COST CAP
  refused to send. Now every cause that fired is named ("...; cost cap reached
  (5 not sent)"). (3) **`citationUrl` fabricated publishers from dotted titles**:
  `Node.js` -> `https://node.js`, which parses cleanly in `new URL()`, reaches
  the sources table and is persisted - a source that does not exist. Now
  TLD-validated against a not-a-TLD denylist (`.md`, `.sh`, `.rs`, `.io`, `.ai`
  are REAL TLDs and still resolve); rejecting is cheap because the fallback is a
  working redirect link. Correctness: (4) **`--judge <legacy-id>` mis-routed to
  the wrong provider** - the judge ENGINE was reverse-looked-up by exact match
  against `DEFAULT_JUDGE_MODELS` with a silent fallback to `availableEngines[0]`,
  so the two ids this wave changed made `--judge gemini-2.5-flash` build an
  OpenAI adapter posting a Gemini id to api.openai.com. `MODEL_PRICING`
  deliberately keeps legacy ids so pinned runs still PRICE - routing had to keep
  working too. New `engineForModel()` matches on the id's own prefix and errors
  honestly on an unroutable id. (5) `priciestPricing()` ranked by summed
  per-token rates and so ignored the new `perRequestUsd`, breaking its documented
  never-under-estimate guarantee for short calls; now ranked by a reference-call
  cost. (6) `computeCost` returned 0 when `usage` was absent, dropping a
  per-request fee that was already incurred. Cleanups: the "cost-capped,
  degraded, or missing engines" wording named three causes after a fourth
  existed (now interpolated from a new `partialCauses()`), and the
  `partialEngines` render test asserted bare `toContain('1')`/`toContain('8')` -
  digits already present in the report, so the reviewer's mutation (deleting both
  numbers from the note) left the suite green. Now asserts the phrase.
  **Meta-lesson banked: fixing a hand-rolled projection is not enough - delete
  the enumeration.** Four separate submissions found the same `--json` gap, and
  the M8 review had already fixed this exact class once; a call site that LISTS
  honesty fields will always miss the next one.

- 2026-07-20: **`--max-cost` was not actually enforced - found by live testing,
  fixed, and re-verified live.** With Gemini billing enabled, a deliberate
  low-cap run (`--max-cost 0.20`) spent **$0.3481, a 74% breach** of a control
  the product's whole "BYO keys, you control spend" premise rests on (hard rule
  #5). Two compounding causes, both measured: (1) the static per-call estimate
  assumes 500 output tokens, but Gemini averaged **2584** because thinking
  tokens bill as output - so authorizations were **4.9x too small** (OpenAI 1.1x
  and Perplexity 1.0x were fine). Ironically the previous commit's fix to COUNT
  thinking tokens is what made the recorded spend accurate enough to expose the
  stale ESTIMATE. (2) `authorize()` compared against RECORDED spend only, and
  recording happens after a call returns, so every concurrently in-flight call
  was authorized against a total that excluded all the others - with 4
  concurrent x 3 engines, a dozen calls each claimed the same headroom.
  Fixed in three layers, each verified live: **reserve-and-settle** in
  `CostGuard` (authorize now holds the projected cost; `settle(reserved, actual)`
  replaces the hold with the real figure, and a failed call settles at 0 so the
  hold cannot leak) took it to $0.2562 (+28%); **adaptive authorization** in the
  runner (once an engine has completed a call, later calls are authorized
  against its OBSERVED cost, not the assumption) fixed later waves; and a
  **single probe call before fanning out** (only when a guard is enforcing a
  budget) removed the remaining first-wave blind spot, since a fresh engine has
  nothing to adapt to yet. Final live run: **$0.1787 against a $0.20 cap, 11%
  under**, with all three engines honestly reported as partial with counts and
  cause. Migrated all four spender call sites (discovery, query-gen, scoring
  judge, runner) from `record` to `settle`; `record` remains for unreserved
  spend and its docstring warns against pairing it with `authorize`. +9 tests
  (426 -> 433). **Lessons: (a) a cap that is only CHECKED is not enforced -
  concurrent spenders need a reservation; (b) fixing cost RECORDING can expose a
  stale cost ESTIMATE, because the two were wrong in compensating directions;
  (c) the adversarial verifier partially refuted a theoretical version of this
  finding during the code review - reading the code could not settle an
  empirical question, and only a live run with a deliberately low cap could.**

- 2026-07-20: **high-effort workflow review of `671da63..HEAD`** (the 6 unreviewed
  M17 commits), 32 agents (4 finder angles + per-location adversarial verify).
  28 candidates, 9 refuted, **10 findings kept, all fixed test-first** (+21
  tests, 468 -> 489). Three finders independently found the same reservation
  leak. The uncomfortable headline: **the commit that fixed a 74% cap breach
  still had four more paths to breach the cap.** Money fixes: (1) `settle`
  booked actual spend with NO cap re-check, so a call overshooting its
  reservation sailed past `--max-cost` with `costCapped` never set - the
  envelope claimed a clean full-confidence run while the footer printed a total
  above the cap; a shared `flagIfOverCap` now fires from `settle`/`record` (the
  money is already spent and cannot be refused, but it MUST be reported).
  (2) The probe learned only from a SUCCESSFUL call, so one transient 429 on
  the first prompt sent the whole concurrent wave out against the stale
  estimate the probe exists to replace - it now probes sequentially until a
  real cost is observed. (3) `estimateCall` returned **0** for an unpriced
  model, so every `authorize(0)` succeeded and the cap was silently
  unenforceable for that engine - unknown now means "assume expensive" via
  `priciestPricing`. (4) `generateQueries` never settled its setup reservation
  on error (competitors.ts and judge.ts both did), so a failed query-gen call
  held budget for the run's life and forced premature capping over money never
  spent. (5) `costCapped` latching made `askAll` short-circuit and abandon
  every remaining prompt after one transient reservation spike; the flag is
  history, the BUDGET governs new spend, so each prompt is now offered to the
  guard on its own merits. Honesty fixes: a zero `spendBreakdown` is always
  defined so `buildEnvelope`'s "absent means not recorded" guard never fired
  and an unpriced run printed a fabricated `$0.0000` (renderers now say nothing
  at zero, since it is indistinguishable from "could not price"); the aborted
  branch wrote prose to stdout under `--json`, breaking `JSON.parse` for
  agents; and `RunCheckResult.spend` was populated on both ABORT paths but
  dropped from the success return, so the field existed exactly for runs that
  spent nothing. Plus `validateEnvelope` now vouches for every `spend` member
  (renderers call `.toFixed` on them - M8 lesson #3).
- 2026-07-20: **the review's fixes were verified live, and the live run found
  what reading could not.** A deliberate `--max-cost 0.20 --grounded` run still
  breached by **47%** ($0.2936). Diagnosis by back-solving real per-call costs:
  the four engines each fire one concurrent unmeasured probe, reserving $0.1095
  together and settling at $0.2097 - blowing the cap before any fan-out.
  **Root cause was a stale measurement, not a design flaw:** `avgOutputTokens`
  was 500, a figure predating the thinking-model generation, while real asks
  measured **2583 (OpenAI), 3356 (Gemini), 700 (Anthropic), 400 (Perplexity)**.
  The global default is now 2600 with per-model overrides from those
  measurements, which cut the breach to 16%. The residual was the irreducible
  part - a call's cost is unknowable until it returns - so unmeasured calls now
  reserve with a documented `UNMEASURED_CALL_MARGIN` (1.5, sized from the
  observed ~1.3x spread), dropped as soon as the engine reports a real cost.
  **Final live run: $0.1605 against the $0.20 cap, 80% used, and it returned
  MORE answers (11 vs 6) than the breaching run** - accurate estimates buy
  coverage, they do not just restrict it. Lessons: (a) a cap that only compares
  is not enforced, and one that never re-checks after spending is not honest
  either; (b) three separate live runs were needed because each fix exposed the
  next layer, and none of the three causes was visible from the code alone;
  (c) test caps must be DERIVED from the same constants the runner reserves
  against - three existing tests silently re-targeted when the assumption
  moved, one of them passing only because unpriced models used to reserve $0.
- [ ] **`--max-cost` is now a bounded best-effort guarantee, not an absolute
      one - document it before launch.** A call's cost cannot be known until it
      returns, so the honest promise is: the cap is enforced before every call,
      overshoot is bounded by the unmeasured first call per engine (margined 1.5x),
      and any overshoot is always reported via `costCapped` plus per-engine counts.
      README and `--help` should say this rather than implying a hard ceiling.

## Carried risks / decisions to watch

- [x] Confirm M4/M5 truly depend only on `JudgeClient` (no concrete M6 import creeps in) - both cleared; discovery/ and queries/ import only `../types` + `../costs`, never `../engines`
- [ ] Confirm no orchestration logic leaks into `cli/`/`mcp/` (must live in M10) - M10 `runCheck`/`runAudit` now own the full flow; re-check when M11/M15 wrap them (commands must be thin: parse flags → call run → render)
- [ ] ACP/UCP spec churn - LAUNCH #2 RISK ONLY now that M13/M14 are deferred (nothing in the launch #1 build depends on these specs). M13 notes captured 2026-07-16 (`docs/PROTOCOL-NOTES.md`); re-verify before rebuilding the lint rules. Six open questions parked in section 5 (return_policy condition, is_ads_eligible scope, ACP RFC release status, UCP schema churn, exact GMC product spec, GTIN/MPN interdependency drift). The longer launch #2 slips, the staler these get.
- [ ] Reserved "first" claim ("first open-source SKU-level AI shopping visibility tool") - re-verify when M12 ships at launch #2. Do NOT make this claim at launch #1, which ships no SKU-level capability.
- [x] Shared `core` load-time validation helper: `loadProfile`, `parseQueryPack`, and `loadSnapshot` each hand-rolled schema_version-by-value + required-field checks (M8 review lesson #3). Done - `core/validation.ts` (`createValidator(fail)`, error-agnostic so each loader keeps its own error type); all three routed through it. Closed the drift the extraction exposed: `loadProfile`/`parseQueryPack` previously only string-checked `schema_version` while `loadSnapshot` compared it by value - now all three reject an incompatible version (rule #2). +10 tests (269→279).

### Dev-plan research follow-ups (Profound fanout study, as of Apr 2026)

Synced into `docs/dev-plan.md` on 2026-07-16 from the external research-updated copy. These land on ALREADY-SHIPPED modules (M5/M6/M7), so each is rework, not new-module scope. All three cite one study - frame as "per [study], as of [date]" and re-verify at release (M17), since prompt-rewriting behavior shifts as providers change retrieval stacks.

- [x] **M5 retrieval-informed prompt rules DONE 2026-07-18.** `best-of` now weighted highest via `intentQuotas(target, intents)` (weights best-of 2, rest 1; largest-remainder rounding, best-of wins ties) - used BOTH to request more best-of from the judge (per-intent counts in the gen prompt, `quota + 1` buffer so competitor-stripping/de-dupe never shrinks the pack) AND to fill the capped pack (quota fill + round-robin backfill). The generation prompt gained the concrete-over-thematic rule, the constrained+unconstrained-variant rule (pair counts toward the intent's number, never on top - so no additive spend), and an explicit keep-geo-qualifier line. The fill is **smooth weighted round-robin** (nginx-style): best-of is over-represented but SPREAD through the pack, so a cost-capped/truncated run (askAll stops in pack order) still samples every intent and its partial score stays balanced (a review finding - the first draft used quota BLOCKS that front-loaded best-of; fixed). SWRR reproduces the original interleave for the golden, so `golden-pack.yml` is unchanged. The judge output budget now scales with the ask (`max(900, requestedQuestions * 60)`) so the bigger weighted+paired ask is not truncated into an empty pack (review finding). +5 tests.
- [x] **M6 `fanoutQueries?: string[]` DONE 2026-07-18** (optional, backward-compatible on `EngineAnswer` + `ParsedResponse`). The OpenAI grounded parser reads `output[] -> {type:'web_search_call'}.action.queries` (falls back to `action.query`), de-duped; omitted when absent, never fabricated (rule #6). It rides in the M8 envelope automatically (the envelope carries the raw `answers`), and the HTML evidence block now surfaces it as a "Searched for: ..." line when present (review finding - closes lesson #7 fetch-and-discard; shown only when captured, escaped, never fabricated). No schema bump. +3 tests. Perplexity/Gemini still UNVERIFIED (no keys) - no cross-engine computed UI until M17.
- [x] **M7 retrieval-stability as HONEST FRAMING DONE 2026-07-18.** `RETRIEVAL_STABILITY` constant in scoring (source `Profound fanout study`, `asOf 2026-04`, `lastUpdated`, per-engine `high|low` - openai/gemini high, anthropic/perplexity low; anthropic/gemini inferred + flagged least-certain, like `MODEL_PRICING`) + `retrievalVariance(engine)`. The `check` renderers (terminal AND HTML) mark wider-estimate engines with `*` and print a singular/plural-aware "... vary more run to run ... treat ... as wider estimate(s)" note - framing ONLY, the score is untouched. **The marker gates on `e.kind === 'grounded'` AND high variance** (fixed in the code review below): a parametric answer ran no search, so claiming it "rewrites your prompt before searching" would be false (rule #6). Verified live: a default parametric run shows NO marker; a grounded run marks openai only, singular copy. METHODOLOGY.md gained the generated-prompts honesty paragraph + a "Retrieval variance" section + two Honesty-notes bullets. Shared `output/variance.ts` (`isWiderEstimate`/`varianceNote`) keeps the two renderers consistent. Re-verify variance values at M17.
