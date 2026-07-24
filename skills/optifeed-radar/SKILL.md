---
name: optifeed-radar
description: Check whether AI engines (ChatGPT, Perplexity, Gemini, Claude) recommend a brand when buyers ask, and score its AI visibility. Use when someone asks "does AI recommend my brand", wants an AI visibility / GEO / AEO check, wants to know whether AI recommends specific products they name, or wants to audit a site's AI-readiness. Runs locally with the user's own engine API keys. The zero-key audit is free; the check pipeline spends the user's API credit, from about $0.09 for one engine to about $1.09 for four engines with web search.
---

# Optifeed Radar

Optifeed Radar is an open-source CLI and MCP server that asks real AI engines
real buyer questions and measures whether a brand gets recommended. It runs
locally, uses the user's own API keys, and stores nothing on a server.

## Requirements

- Node >= 20.
- For the `check` pipeline, at least one engine API key in the environment:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (Gemini), or
  `PERPLEXITY_API_KEY`. The zero-key `audit` needs no keys.

## Commands (CLI)

Run it with `npx optifeed-radar <command>` (no clone needed). From a clone,
use `npx tsx src/cli/index.ts <command>` instead.

- `audit <domain>` - zero-key AI-readiness check (robots.txt, llms.txt,
  schema.org, meta, sitemap). No AI calls, costs nothing.
- `check <domain>` - the full pipeline: generate buyer prompts, ask the
  engines, score recommendation, position, and share of voice into one AI
  Visibility Score. Needs at least one API key.
- `shopping <domain> --products "A, B, C"` - product-level check (beta) for
  the products the user NAMES, in any order. Each product gets its own 0-100
  visibility score and the report is sorted by what the engines did, with any
  product they never recommended first.
  `--products-file products.yml` takes a name, aliases,
  and a descriptor per product; the descriptor ("quiet home espresso machine")
  is what rescues an opaque product name. Max 10 products per run. There is no
  catalog import, so ask the user which products to check.
- `diff <domain>` - what changed between the last two saved runs.
- `sources <domain>` - domains the AI cited, and the brand's share of voice.
- `queries <domain>` - show or export the buyer-prompt pack.
- `config` - which engine keys are set and where state is stored (never the
  key value).

Useful `check` flags: `--json`, `--report report.html`, `--max-cost 0.50`,
`--quick`, `--grounded`, `--fail-under 50`, `--yes` (skip the cost prompt so
an AI agent can run it unattended).

## Tools (MCP)

The `optifeed-mcp` server exposes the same capability to AI agents:

- `check_visibility` - run a visibility check for a domain.
- `audit_store` - run the zero-key readiness audit.
- `generate_buyer_queries` - produce the buyer-prompt pack.
- `shopping_check` - product-level check for products the user names, in any
  order.
- `get_snapshot_diff` - compare two saved runs.

## Worked example

```bash
npx optifeed-radar audit example.com
export OPENAI_API_KEY=...   # or put keys in a .env file in this directory
npx optifeed-radar check example.com --quick --yes
```

The CLI loads `.env` from the directory it runs in; an exported key wins over
the same key in `.env`. `config` reports which keys were found and which file
they came from, never the values.

How long to expect (measured 2026-07-22): `audit` takes about a second,
`check --quick` across four engines takes 47 to 51 seconds, and about 97
seconds with `--grounded`. That wait is the engines answering, not a hang;
`check` streams per-phase progress to stderr while it runs.

## Honesty and cost

BYO keys. Scores are estimates from sampling and say so; engines vary between
runs. Grounded engines (which cite sources) are reported separately from
parametric ones (which answer from model weights alone), and an engine counts
as grounded only for the answers where it actually searched - asking for
grounded mode is not the same as searching, and the report says so when an
engine searched on only some of its answers. Keys stay on the user's machine
and are never logged or stored.

Cost, measured on real runs (2026-07-20, `--quick` = 8 buyer prompts): the
zero-key `audit` is free; a single-engine `check` is about $0.09; all four
engines is $0.41 to $0.46; adding `--grounded` takes that to about $1.09,
since web search is billed on top of tokens. Every run reports what it spent,
split into setup and engine calls. `--max-cost` caps spend and is checked
before every call, but a call's cost is not known until it returns, so a run
can exceed the cap by at most one unmeasured call per engine; any overshoot is
always reported. Confirm the cost with the user before running `check` on a
large prompt pack or with `--grounded`.

A `shopping` run is bigger than a check: up to 4 prompts per product on every
engine with a key (products that share a category share their category
questions, which are asked once), so start with two or three products and
`--max-cost`. No shopping run has been measured across multiple engines yet,
so do not quote a cost figure for it. What IS fixed: the MCP tool caps at
$0.20 per product by default.

Catalog discovery (importing products from a store or a feed) and product-feed
linting are on the roadmap, not shipped - join the waitlist at optifeed.com.

More at optifeed.com
