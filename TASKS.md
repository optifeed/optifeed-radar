# Optifeed Visibility - Build Tracker

Living checklist for the build. Source of scope: the dev plan
(`docs/dev-plan.md`, the authoritative in-repo copy). This file tracks
**status only** - it does not restate the plan. Keep the two in sync: if scope
changes, edit the plan first, then reflect it here.

> This is the canonical, in-repo copy (moved here when M0 scaffolded the repo).
> The planning-workspace copy is superseded.

> **SCOPE REVISION (2026-07-17): launch #1 is brand visibility only.** The
> commerce modules - M12 (shopping), M13 (protocol spike), M14 (lint-feed) -
> are deferred to a separate launch #2 (~4-8 weeks post-launch). Current build
> scope = M0-M11 + M15 (MCP) + M16 (agent surfaces) + M17 (release). M13's and
> M14's shipped code was **removed from the build** on 2026-07-17; their
> entries below are retained as history for launch #2 planning, not as status.
> The dev plan (`docs/dev-plan.md`) is authoritative and carries the same note.

Last updated: 2026-07-17.

## Legend

- `[ ]` not started · `[~]` in progress · `[x]` done (DoD met) · `[!]` blocked
- Each module is DONE only when its **Definition of Done** is met (see below).
- Fill `Owner` / `PR` when a module is picked up.

## Definition of Done (every module)

- [ ] typecheck clean · [ ] vitest green · [ ] fixtures: happy path + ≥2 failure modes
- [ ] exported API has TSDoc · [ ] `## Module report` in the PR (deviations noted)
- [ ] respects the global hard rules (see Invariants below)

## Ship milestones (the gates that matter)

- [~] **`audit` ships** - runnable end to end (`audit <domain>`, zero-key), verified live. Minimal slice: seeds of M9 (text/JSON renderers), M10 (`runAudit`), M11 (`audit` command). Since shipped, closing most of this milestone: the HTML report (`--report`, `renderCheckHtml`), colorized output (`picocolors` in `terminal.ts`/`render-diff.ts`), and M8 snapshot writing (`runCheck` calls `saveSnapshot`). **Still open: `--fail-under` is not wired into any command** (see M11).
- [x] **`check` ships** - full pipeline with ≥1 engine key (M4-M8, M10, M11 `check` cmd). Done at the code level: `runCheck` (M10) wires M3-M8, M9 renders, M11 `check` command is thin over both, all mocked-e2e covered. **LIVE-VERIFIED 2026-07-17** against real OpenAI (`check optifeed.com --quick --engines openai`): discovery → query-gen → 6 buyer prompts + 2 branded → scoring → share of voice → reputation split → snapshot, 34s, ask spend $0.0024. Confirmed live: no key material in the snapshot (rule #4), `schema_version` present, and the provider-echoed DATED model id (`gpt-4o-mini-2024-07-18`) still priced non-zero - the M0-M6 `$0`-cost bug regression-checked against reality. Still unverified live: anthropic, gemini, perplexity (no keys yet).
- [ ] **MCP ships** - stdio server over the same core (M15)
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
- [ ] Judge selection is still purely by PRICE, which now fights the quality fix (found 2026-07-17). `resolveJudgeModel` picks the cheapest default across available engines. With openai's judge now `gpt-5.4` ($2.50/$15) and anthropic's `claude-haiku-4-5` ($1/$5), **adding an Anthropic key silently swaps the judge back to a cheap-tier model** and may reintroduce fabricated competitors. Unverified for haiku specifically (no anthropic key), so the ranking was NOT redesigned on a guess - the current behaviour is pinned by a test so it cannot change silently. Decide once other keys exist: keep "cheapest", or rank judges by recall quality.
- [ ] Non-OpenAI engine + judge models are stale in exactly the way `gpt-4o` was (found 2026-07-17). Only the OpenAI path was verified and updated this session (the only key available). `anthropic: claude-haiku-4-5`, `gemini: gemini-2.5-flash` remain both cheap-tier AND possibly a generation behind what Claude/Gemini users actually get - the same validity gap just fixed for OpenAI. Worse, a mixed run would then compare a flagship-measured OpenAI against a mini-measured Anthropic and fold both into ONE composite score - apples to oranges inside the headline number. Verify model ids + prices from each provider's official sheet before enabling multi-engine runs.
- [ ] Competitor QUALITY in non-English markets is weak (found 2026-07-17, after the locale fix). With `locale: tr` now reaching the judge, `www.do-re.com.tr` returns Turkish names instead of US chains - but the list is mixed: "Müzik Aletleri" is the common noun "musical instruments", not a brand, and Zuhal Müzik (the obvious real rival) is absent. The plumbing is fixed; `gpt-4o-mini` simply does not know Turkish retailers well. This is a judge-quality issue, not a wiring one - consider a stronger judge or a grounded competitor call, and re-check at the M17 smoke test on a non-English domain.
- [ ] For RETAIL brands the share-of-voice axis is structurally mismatched (found 2026-07-17). `doremusic` is a retailer, so buyer prompts like "2026 için en iyi akustik piyanolar hangileri?" elicit MANUFACTURERS - across 20 Turkish answers: Yamaha 9, Kawai 4, Roland 4, Fender 4, Casio 2 - never rival retailers. So even with correct Turkish competitors, a retailer scores 0 and learns little: the answers simply are not about shops. Retailers are a core segment, so decide before launch whether retail brands need retailer-seeking prompts ("Türkiye'de piyano nereden alınır?") and/or a manufacturer-vs-retailer competitor axis. Product decision, not a bug.
- [ ] **No flag selects grounded mode - the grounded variants are unreachable from the CLI (found 2026-07-17).** `runCheck` accepts `opts.mode` and passes it to the runner, but no command sets it, so every engine runs at its spec default `kind`: openai/anthropic/gemini parametric, perplexity grounded. OpenAI's Responses/`web_search` path and Gemini's grounding path are therefore dead code at runtime. With only an OpenAI key configured, a `check` cites NO sources at all - the grounded-vs-parametric split the product is built around never happens. Third instance of build-without-a-call-site (after `CostGuard.authorize` and `failUnder`). Decide the surface: a `--grounded` flag, per-engine mode config, or run both modes and merge.
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

### [ ] M15 - MCP server

Owner: ___ · PR: ___ · thin over M10 (owns final tool names)

- [ ] tools: check_visibility / compare_competitors / audit_store / generate_buyer_queries / get_snapshot_diff (launch #1 list; `shopping_check` + `lint_feed` deferred to launch #2)
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
- [ ] Decide on the `ai-shopping` / `agentic-commerce` keywords in `package.json` before the first publish - launch #1 ships no shopping capability, so they advertise something absent. Keep (forward-looking, launch #2 adds it) or drop until then. Unpublished so far, so nothing is live yet.
- [ ] `build` must clean `dist/` first - `tsc -p tsconfig.build.json` never removes stale output, and `files: ["dist"]` publishes whatever is there. Surfaced by the 2026-07-17 M14 removal: deleted modules stayed in `dist/` until a manual `rm -rf`, so a publish from a stale tree would ship code that is no longer in `src/` (here: deferred commerce code, at launch #1). Verified a clean rebuild emits none of it.
- [ ] A run never tells the user what it SPENT (found 2026-07-17). The live `check` billed $0.0024 and reported it nowhere - the cost is only recoverable by summing `costUsd` across `answers` in the snapshot JSON. `--yes` skips the confirm gate that shows the estimate, so an agent or CI run (the documented path) sees no cost at all, before or after. A money-spending tool should print actual spend in the report footer. Cheap: the envelope already carries per-answer `costUsd`.
- [ ] smoke-test script (3 real domains, prints cost); `npx` cold-run <60s; Win/macOS/Linux CI matrix. Pair it with the live-verification debt: only OpenAI parametric is proven (2026-07-17); anthropic/gemini/perplexity wire shapes and OpenAI grounded-in-a-real-`check` are still unexercised. Gemini's grounding shape is the same category of risk the OpenAI grounded bug came from - hand-written, untested, unreachable.
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

## Carried risks / decisions to watch

- [x] Confirm M4/M5 truly depend only on `JudgeClient` (no concrete M6 import creeps in) - both cleared; discovery/ and queries/ import only `../types` + `../costs`, never `../engines`
- [ ] Confirm no orchestration logic leaks into `cli/`/`mcp/` (must live in M10) - M10 `runCheck`/`runAudit` now own the full flow; re-check when M11/M15 wrap them (commands must be thin: parse flags → call run → render)
- [ ] ACP/UCP spec churn - LAUNCH #2 RISK ONLY now that M13/M14 are deferred (nothing in the launch #1 build depends on these specs). M13 notes captured 2026-07-16 (`docs/PROTOCOL-NOTES.md`); re-verify before rebuilding the lint rules. Six open questions parked in section 5 (return_policy condition, is_ads_eligible scope, ACP RFC release status, UCP schema churn, exact GMC product spec, GTIN/MPN interdependency drift). The longer launch #2 slips, the staler these get.
- [ ] Reserved "first" claim ("first open-source SKU-level AI shopping visibility tool") - re-verify when M12 ships at launch #2. Do NOT make this claim at launch #1, which ships no SKU-level capability.
- [x] Shared `core` load-time validation helper: `loadProfile`, `parseQueryPack`, and `loadSnapshot` each hand-rolled schema_version-by-value + required-field checks (M8 review lesson #3). Done - `core/validation.ts` (`createValidator(fail)`, error-agnostic so each loader keeps its own error type); all three routed through it. Closed the drift the extraction exposed: `loadProfile`/`parseQueryPack` previously only string-checked `schema_version` while `loadSnapshot` compared it by value - now all three reject an incompatible version (rule #2). +10 tests (269→279).

### Dev-plan research follow-ups (Profound fanout study, as of Apr 2026)

Synced into `docs/dev-plan.md` on 2026-07-16 from the external research-updated copy. These land on ALREADY-SHIPPED modules (M5/M6/M7), so each is rework, not new-module scope. All three cite one study - frame as "per [study], as of [date]" and re-verify at release (M17), since prompt-rewriting behavior shifts as providers change retrieval stacks.

- [ ] M5 retrieval-informed prompt rules: weight `best-of` highest (most rewrite-stable); generate a constrained + unconstrained variant for price/spec prompts BUT keep the pair inside `DEFAULT_QUERY_COUNT` + the setup budget (never additive spend); keep geo qualifiers; prefer concrete over thematic. Cheap, low-risk - fold in opportunistically.
- [ ] M6 `fanoutQueries?: string[]` on `EngineAnswer` (optional, backward-compatible): capture the internal search queries an engine ran where the API exposes them. Omit when absent, never fabricate (rule #6). **OpenAI support VERIFIED live 2026-07-17** - the exact path is `output[] -> {type:'web_search_call'}.action.queries` (a `string[]`; `action.query` also carries the single query). Real example: prompt "What are the best product feed management tools in 2026?" -> `["best product feed management tools 2026"]`. The `ResponsesShape` type already models `action.queries`; the parser just does not read it yet. Perplexity/Gemini still UNVERIFIED (no keys) - check before building renderer UI across engines.
- [ ] M7 per-engine retrieval-stability as HONEST FRAMING, not a numeric modifier (fake-precision copy rule): surface a qualitative confidence qualifier for high-variance engines (ChatGPT ~91% unique queries vs Perplexity ~14%); do NOT let it adjust the score. If a `stability` constant is stored, tag it approximate with `lastUpdated` + source (like `MODEL_PRICING`). Also add the METHODOLOGY honesty line: our prompts are GENERATED approximations, not real user prompt data (why the pack is editable) - this part is unconditionally worth shipping.
