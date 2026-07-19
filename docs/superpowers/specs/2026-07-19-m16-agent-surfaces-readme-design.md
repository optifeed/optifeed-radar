# M16 - Agent surfaces + README (as "Optifeed Radar") - Design

Date: 2026-07-19
Module: M16 (Wave 5, launch #1 scope)
Status: approved design, ready for implementation plan

## Goal

Ship the distribution artifacts for launch #1: the agent-facing surfaces
(SKILL.md, Claude Code plugin manifest, per-platform ai-context files) and a
full README rewrite, all under the public product name **Optifeed Radar**.
Acceptance (from the dev plan): copy passes the messaging guide, SKILL.md
validates against the ClawHub schema, and every config snippet is pasted-and
-tested.

## Decisions locked during brainstorming

1. **Product name = "Optifeed Radar"** (matches the messaging guide in
   `optifeed-radar-docs/source-of-truth.html`, panel "Messaging Guide"). The
   brand token stays "Optifeed" (never "OptiFeed").
2. **Package + CLI bin renamed to `optifeed-radar`.** The MCP bin stays
   `optifeed-mcp` (product-neutral). dist paths and the `.optifeed/` state dir
   are unchanged.
3. **Pre-release honest install framing.** The npm package is unpublished
   (version 0.0.0), so `npx optifeed-radar` is not yet runnable. The clone path
   is present-true and leads; `npx`/npm availability is documented but marked
   pending, flipped to present tense at M17 (publish). This honors the
   messaging-guide tense rule (present tense only for shipped/provable).
4. **Approach A: full M16 in one session + an automated copy-lint test.** The
   copy-lint is the module's real failure-mode coverage (a docs module's whole
   risk surface is copy correctness), mirroring the existing
   `no-restricted-imports` machine check.
5. **Badge wall:** include npm-dependent badges (npm version, downloads,
   glama, Smithery) now with a "lights up at launch" note; do not fake a live
   badge. License / CI / stars badges work today.
6. **Rename scope touches CLAUDE.md and TASKS.md minimally** (product-name
   references only) plus the docs-repo dev-plan Global Decision (kept in sync
   per the plan-first rule).

## Authoritative sources

- Messaging guide: `optifeed-radar-docs/source-of-truth.html`, `#messaging`
  panel (brand basics, honesty rules, positioning hierarchy, voice, preferred
  terms, pre-publish checklist). README/directory-listing patterns: the
  Playbook panel ("README patterns to copy", "Directory Listing Copy",
  awesome-mcp-servers listing mechanics).
- Dev plan M16: `optifeed-radar-docs/dev-plan.md`.
- Copy rules also in repo `CLAUDE.md` ("Copy rules" section).

## Actual surfaces to document (verified against code)

- **CLI** (`optifeed-radar` bin): `audit`, `check`, `diff`, `sources`,
  `queries`, `config`.
- **MCP** (`optifeed-mcp` bin): `check_visibility`, `audit_store`,
  `generate_buyer_queries`, `get_snapshot_diff`.
- Zero-key path: `audit` (verified live, $0). `check`: BYO keys; a real
  `--quick` single-engine (OpenAI, gpt-5.3/5.4) run measured ~$0.09 - use as
  an honestly-labeled estimate, never as fake precision.
- Grounded vs parametric engines are reported separately (copy must preserve
  this distinction).

## Deliverables

### 1. Rename (`optifeed-visibility` -> `optifeed-radar`)

- `package.json`: `name` -> `optifeed-radar`; `bin` key
  `optifeed-visibility` -> `optifeed-radar`. MCP bin unchanged.
- `src/cli/index.ts`: commander program `.name(...)` -> `optifeed-radar` so
  `--help` / usage / error text match the new bin. (Verify no other code or
  test asserts the old program name; update any that do.)
- `CLAUDE.md`, `TASKS.md`: product-name references updated (minimal).
- Docs repo `dev-plan.md` Global Decisions: package name -> `optifeed-radar`.
- Do NOT touch: `.optifeed/` state dir naming, keywords array (M17), dist
  layout.

### 2. SKILL.md (repo root, ClawHub/OpenClaw format)

- Frontmatter: `name`, `description` (when-to-use + a cost hint). Confirm the
  exact ClawHub Skill Card frontmatter schema before writing (via context7 /
  claude-code-guide); the superpowers skill format (`name` + `description`) is
  the baseline.
- Body: requirements (Node >= 20; engine API keys via env - name the four env
  vars); command reference (6 CLI commands + 4 MCP tools, one line each);
  one worked example invocation; honesty + cost note (BYO keys, estimates,
  local, nothing stored); footer CTA.

### 3. .claude-plugin/plugin.json (Claude Code plugin manifest)

- Fields per the Claude Code plugin schema: name, version, description,
  author, and wiring for the MCP server (stdio, `optifeed-mcp`) + the skill.
  Confirm the manifest schema via the claude-code-guide agent before writing.
- Note: this manifest follows the plugin spec's own schema. Hard rule #2
  (`schema_version` on every JSON output) governs OUR serialized data
  envelopes/snapshots, not an externally-specified config manifest; do not
  bolt `schema_version` onto plugin.json.

### 4. ai-context/ (four per-platform context files)

- `claude-project.md` - Claude Projects custom instructions.
- `chatgpt-custom-gpt.md` - ChatGPT custom GPT instructions.
- `cursor.mdc` - Cursor rules (MDC frontmatter: description / globs /
  alwaysApply).
- `windsurf.md` - Windsurf rules.
- Each: compact "what Optifeed Radar is / how to invoke (CLI + MCP) / when to
  use / cost + honesty" block tuned to that platform.

### 5. README rewrite (pre-release honest)

Section order:

1. Title + primary line + badge wall (license/CI/stars live now; npm-dependent
   badges present with a launch note).
2. 60-Second Setup - clone path leads (present-true); `npx optifeed-radar`
   shown with "published to npm at launch" note.
3. What it does / positioning - real buyer questions -> real engines ->
   recommendation measurement; both agent-first meanings; GEO/AEO/AI-SEO
   synonyms named once.
4. Per-client config blocks - Claude Desktop, Claude Code, Cursor, Windsurf
   (MCP JSON, `optifeed-mcp`; clone+build path works now, npm path pending).
5. Tools table (CLI + MCP) + cost transparency: `audit` = $0/zero-key;
   `check` = BYO keys, honestly-rough estimate, `--quick` vs full.
6. Example prompts + sample output (real zero-key `audit`; a real `check`).
7. FAQ (keyword Q&A for SEO/LLM citation: AI visibility / GEO / AEO, MCP
   server, cost, data storage, engines, score computation -> METHODOLOGY.md).
8. Directory Listing Copy (pre-written one-liners for awesome-mcp-servers /
   ClawHub / Smithery using the real `optifeed-radar` package name) +
   search-intents keyword block.
9. "What this does NOT do" (point-in-time not monitoring; estimates vary; no
   SKU/Shopping yet - future tense + waitlist; BYO keys cost money; not a
   ranking).
10. Footer CTA (echoes the single `FOOTER_CTA` constant from `core/output`).

### 6. Verification

- `test/copy/messaging.test.ts` (vitest) reads README.md, SKILL.md,
  `ai-context/*`, and the plugin manifest's text fields; asserts the
  unambiguous messaging rules: no em-dash, no "OptiFeed" mis-casing, no
  free-vs-paid equivalence phrases, Shopping/roadmap future-tense (no
  present-tense Shopping claims; "waitlist"/"coming" present), footer CTA
  present. Prefer plain `String.includes` over regex where possible (known
  regex-exec hook conflict, see memory `regex-exec-hook-conflict`).
- Config-block validation test: extract ```json fenced MCP config blocks from
  README and `JSON.parse` each, so no snippet ships malformed.
- Manual: hand-walk the pre-publish checklist for judgement-based rules (bare
  "agents", HN-survivable voice) - noted honestly as not machine-checked.
- Live: rebuild and re-verify the `optifeed-mcp` stdio handshake under the
  renamed package. `npx optifeed-radar` cannot be run (unpublished) - folds
  into the M17 smoke test.

## Out of scope (kept honest)

Hosted/landing pages, actual directory-submission PRs (M17 at launch), the npm
publish itself (M17), badges going live (M17), any Shopping present-tense copy.

## Definition of done

- typecheck + vitest green (copy-lint + config-block tests included);
  `npm run check` and `npm run format:check` clean; `npm run build` emits.
- SKILL.md frontmatter validates against the confirmed ClawHub schema; plugin
  manifest valid per the confirmed Claude Code plugin schema.
- Every README config snippet parses; the clone+build MCP handshake verified
  live under the new package name.
- `## Module report` in the PR: what shipped, the rename's cross-repo touch,
  what M17 must flip (npm-present-tense, badges live, listing PRs).

## Risks / watch items

- Exact ClawHub SKILL frontmatter and Claude Code plugin manifest schemas must
  be confirmed against current docs before writing (not guessed) - a
  hand-written manifest shape is a guess until validated (repo lesson: a
  hand-written type is a guess until a real payload proves it).
- The copy-lint must not over-match and block legitimate copy; keep the
  automated set to unambiguous rules, leave judgement calls to the checklist.
- Rename must be complete: a stray `optifeed-visibility` in help text or a test
  asserting the old name would ship an inconsistent surface.
