# Changelog

All notable changes to Optifeed Radar are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/). Pre-1.0, a minor bump may change output shapes.

## How a release is cut

1. Move the `Unreleased` entries into a new version heading with today's date.
2. Bump `version` in `package.json` to match.
3. `npm run check && npm run format:check && npm run build`.
4. `node scripts/verify-release-tag.mjs v<version>`. It fails if the tag you are
   about to create disagrees with `package.json`, which is the mistake that is
   cheap to make and expensive to undo: npm refuses to republish a version, so a
   tag pointing at the wrong version can only be fixed by burning a version
   number.
5. Commit, then tag: `git tag v<version> && git push && git push --tags`.
6. Review what will ship with `npm pack --dry-run`, then publish by hand:
   `npm publish` (add `--otp=<code>` if the account has 2FA).

Publishing is MANUAL as of 2026-07-24; the workflow that published on tag push
was removed. That also means releases carry no npm provenance attestation:
provenance requires a trusted CI publisher with OIDC, which a local `npm
publish` cannot produce. Restoring it means restoring a release workflow, and
the `publishing stays manual` guard in `test/packaging.test.ts` is what makes
that a deliberate act rather than a quiet one.

Anything that changes a serialized format (envelope, snapshot, query pack,
profile) also bumps `schema_version` and updates the golden fixtures. Scoring
changes that move the headline number are called out explicitly, because a
score is only comparable against snapshots taken with the same method.

## [Unreleased]

## [0.2.2] - 2026-07-25

Documentation and registry metadata only. No code changed, so `schema_version`
stays at `0.3` and snapshots taken with 0.2.0 or 0.2.1 remain comparable.

### Added

- `mcpName` in `package.json`
  (`io.github.optifeed/optifeed-radar`), which is how the MCP Registry
  verifies that the npm package and the server entry share an owner.
- `glama.json` (repo only, not shipped in the tarball) declaring the schema and
  maintainers for Glama maintainer verification.
- Product visuals in the README: an overview image, a linked CLI demo video
  with a still preview, and a shot of the MCP server running in Claude Desktop.

### Changed

- README claims now match what the code does. "Stores nothing on a server"
  became "has no Optifeed-hosted backend", and the data and API-key answers now
  say what is actually true: keys go to their corresponding AI provider because
  that is what making the call requires, are never logged or stored by Optifeed
  Radar, and prompts and responses are then handled under that provider's data
  policies. The MCP `shopping_check` example no longer describes input order as
  a ranking - 0.2.0 removed that, and the copy had not caught up. It only
  breaks ties between identical scores.

## [0.2.1] - 2026-07-24

### Fixed

- The build now makes `dist/cli/index.js` and `dist/mcp/index.js` executable
  (`scripts/fix-bin-permissions.mjs`). `tsc` writes 0644 and nothing restored
  the execute bit. npm papered over it: bin-links chmods a bin target whenever
  it creates the symlink, so registry installs, `file:` dependencies,
  `npm link` and `npx <path>` all produced a working binary - at link time
  only. Rebuilding after that recreated the file at 0644 behind the same
  symlink and the binary stopped working with `Permission denied`; executing
  `dist/cli/index.js` directly failed the same way. Installing 0.1.0 or 0.2.0
  from npm was unaffected, which is why this went unnoticed, but the tarball
  did ship 0644 - executability rested on the installer rather than on the
  build. It is now the build's job.

## [0.2.0] - 2026-07-24

`shopping` no longer reads the order you list products in as a ranking. If you
script against a shopping run's JSON, `rankingDelta` is gone and
`schema_version` is now `0.3`.

### Changed

- **`shopping` orders products by what the engines did, not by what you
  typed.** Any product the engines answered about but never recommended leads,
  because that is the finding worth reading; then the rest by visibility; then
  last, anything the run could not measure at all (no category questions
  written, or none answered). A product that was never measured is not a bad
  score and must not sort as one. The order you list products in carries no
  ranking meaning, and only breaks ties between identical scores. The report
  states once that products were asked different questions, so a higher score
  means "wins its own shelf more decisively", never "beats the product below
  it".
- **`schema_version` is `0.3`** (was `0.2`), for the removed fields. Cached
  profiles and query packs rebuild themselves on first run; snapshots saved
  under `0.2` no longer load, so `diff` cannot reach across the change. No
  migration is provided.
- Releases are now published by hand rather than by a workflow on tag push, so
  this release carries no npm provenance attestation.

### Removed

- **The merchant-ranking delta**, and with it `rankingDelta` from the shopping
  envelope and `merchantRank` from each product. Listing products "best first"
  was never validated, could not be opted out of, and nothing in the output
  told a deliberate ranking apart from a list typed in an arbitrary order, so
  typing order was being promoted into a published leaderboard: a real run
  reported a product "down 2 places" off a four-point spread across twelve
  answers. "Down N places" also described movement for something that never
  moved, which is what `diff` reports and this never was. A delta of this kind
  needs a ranking the tool can actually trust, such as a store's own bestseller
  order, rather than one typed at the command line.

### Fixed

- Loading a saved shopping run now validates `avgPosition`. A file without it
  rendered "average shelf rank undefined" in the summary.

## [0.1.0] - 2026-07-23

First public release.

### Added

- `audit <domain>` - static AI-readiness audit with no API keys and no AI
  calls: AI bot access in robots.txt, llms.txt, structured data, meta basics,
  sitemap.
- `check <domain>` - asks real buyer questions to OpenAI, Anthropic, Google and
  Perplexity and reports an AI Visibility Score, per-engine scores, share of
  voice, and cited sources. Grounded and parametric engines are reported
  separately.
- Buyer questions follow the axis your business is on. Discovery classifies the
  site as a shop, a maker, or a service. A maker is asked what-to-buy questions
  and measured against rival makers; a shop is asked where-to-buy questions
  ("where can I buy a piano?", "which shop sells acoustic guitars?") and
  measured against rival shops, because product questions get answered with
  manufacturers and would score a shop against companies it does not compete
  with. The classification is stored as `businessType` in `profile.json`; edit
  it if it is wrong and it survives `--refresh`. A score is only comparable
  within one axis.
- `shopping <domain> --products "A, B, C"` (beta): a product-level check for
  the products you name, best first. There is no catalog or feed import - you
  name them, and that order is treated as your own ranking. The headline is the
  delta between it and the order engines actually recommend ("your #1 is AI's
  #4"; "your best seller never appears, your #3 carries the shelf"). Each
  product is measured twice over, mirroring the brand check one level down:
  category buying questions that never name it (product visibility) and
  questions that do (product reputation). When a product is absent the report
  leads with the rival products the engines named instead, because a bare zero
  is the least useful half of that result. `--products-file` takes a name,
  aliases, and a descriptor per product; the descriptor is what rescues an
  opaque product name. Capped at 10 products per run, with a shopping-specific
  judge budget of 50% (vs the brand check's 30%, since product names are
  messier) that is reported in the run's sampling metadata. Runs are saved to
  `<stateDir>/shopping/`, deliberately apart from the check snapshots `diff`
  reads.
- `--grounded` to run engines in web-search mode where the provider supports
  it; an engine that cannot search is honestly tagged parametric. The
  composite's premium for retrieval is earned per answer by engines that
  actually searched, not granted to any engine that was asked to: asking is a
  request a model can decline, and on a live run 7 of 8 ChatGPT answers ran no
  search at all. A report says "searched in 1 of 8 answers" when an engine did
  not search on all of them.
- `diff`, `sources`, `queries` and `config` for inspecting saved runs without
  spending anything. `diff` flags when the prompt set, the engine set, the
  scoring method or an engine's retrieval rate changed between two runs, so a
  mechanical move in the number is never read as a real visibility change.
- `--json` (stable envelope carrying `schema_version`), `--report <file>`
  (self-contained HTML), and `--fail-under <n>` for CI gating.
- Cost guard on every call that spends: an estimate before the run, a
  confirmation gate, `--max-cost` / `--max-setup-cost`, and a run cost printed
  in the report. Hitting the cap returns a partial run flagged `costCapped`
  rather than failing, and says which engines were cut short and why.
- MCP server (`optifeed-mcp`) exposing `check_visibility`, `audit_store`,
  `generate_buyer_queries`, `get_snapshot_diff` and `shopping_check` over
  stdio, non-interactive with a default $0.50 cap (the shopping tool's cap
  scales at $0.20 per product).
- The CLI loads a `.env` from the directory you run it in, using Node's
  built-in env-file support (no dependency). A key already exported in your
  shell wins over the same key in `.env`, and `config` reports which file the
  keys came from, never their values.
- Agent surfaces: a Claude Code plugin manifest, a bundled skill, and context
  files for Claude Projects, Custom GPTs, Cursor and Windsurf.
- Published methodology (`METHODOLOGY.md`) with the scoring weights the code
  actually uses.
