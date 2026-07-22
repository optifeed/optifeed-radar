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
