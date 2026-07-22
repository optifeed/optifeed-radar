# Changelog

All notable changes to Optifeed Radar are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/). Pre-1.0, a minor bump may change output shapes.

## How a release is cut

1. Move the `Unreleased` entries into a new version heading with today's date.
2. Bump `version` in `package.json` to match.
3. `npm run check && npm run format:check && npm run build`.
4. Commit, then tag: `git tag v<version> && git push --tags`.
5. The Release workflow re-runs the gate, verifies the tag matches
   `package.json`, reviews the tarball, and publishes to npm with provenance.

Anything that changes a serialized format (envelope, snapshot, query pack,
profile) also bumps `schema_version` and updates the golden fixtures. Scoring
changes that move the headline number are called out explicitly, because a
score is only comparable against snapshots taken with the same method.

## [Unreleased]

### Changed

- Scoring methodology version 3: the composite's retrieval premium is earned by
  answers that actually retrieved, not granted to any engine asked for grounded
  mode. Asking is not searching - a live run had 7 of 8 ChatGPT answers run no
  search while still counting as fully grounded. A run where every grounded
  answer really searched scores the same as before. Reports now say "searched
  in 1 of 8 answers" when an engine did not search on all of them, and `diff`
  flags a comparison across methodology versions as methodology-driven.
- `diff` also flags `retrievalChanged` when an engine searched on a different
  share of its answers than last time. That moves the headline score without
  moving any per-engine score, so without the flag a mechanical change would
  read as a real visibility change.

### Fixed

- The MCP server resolved the home directory from `$HOME`, which Windows does
  not set, so its state directory fell back to whatever working directory the
  desktop client launched it with. It now uses the real home directory, as the
  CLI already did.

### Added

- The CLI loads a `.env` from the directory you run it in, using Node's
  built-in env-file support (no dependency). A key already exported in your
  shell wins over the same key in `.env`, and `config` reports which file the
  keys came from, never their values.

## [0.1.0] - 2026-07-22

First public release.

### Added

- `audit <domain>` - static AI-readiness audit with no API keys and no AI
  calls: AI bot access in robots.txt, llms.txt, structured data, meta basics,
  sitemap.
- `check <domain>` - asks real buyer questions to OpenAI, Anthropic, Google and
  Perplexity and reports an AI Visibility Score, per-engine scores, share of
  voice, and cited sources. Grounded and parametric engines are reported
  separately.
- `--grounded` to run engines in web-search mode where the provider supports
  it; an engine that cannot search is honestly tagged parametric.
- `diff`, `sources`, `queries` and `config` for inspecting saved runs without
  spending anything.
- `--json` (stable envelope carrying `schema_version`), `--report <file>`
  (self-contained HTML), and `--fail-under <n>` for CI gating.
- Cost guard on every call that spends: an estimate before the run, a
  confirmation gate, `--max-cost` / `--max-setup-cost`, and a run cost printed
  in the report. Hitting the cap returns a partial run flagged `costCapped`
  rather than failing.
- MCP server (`optifeed-mcp`) exposing `check_visibility`, `audit_store`,
  `generate_buyer_queries` and `get_snapshot_diff` over stdio, non-interactive
  with a default $0.50 cap.
- Agent surfaces: a Claude Code plugin manifest, a bundled skill, and context
  files for Claude Projects, Custom GPTs, Cursor and Windsurf.
- Published methodology (`METHODOLOGY.md`) with the scoring weights the code
  actually uses.
