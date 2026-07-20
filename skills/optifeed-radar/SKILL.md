---
name: optifeed-radar
description: Check whether AI engines (ChatGPT, Perplexity, Gemini, Claude) recommend a brand when buyers ask, and score its AI visibility. Use when someone asks "does AI recommend my brand", wants an AI visibility / GEO / AEO check, or wants to audit a site's AI-readiness. Runs locally with the user's own engine API keys. The zero-key audit is free; the check pipeline spends the user's API credit, from about $0.09 for one engine to about $1.09 for four engines with web search.
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

Run from a clone with `npx tsx src/cli/index.ts <command>` (published `npx
optifeed-radar <command>` at launch).

- `audit <domain>` - zero-key AI-readiness check (robots.txt, llms.txt,
  schema.org, meta, sitemap). No AI calls, costs nothing.
- `check <domain>` - the full pipeline: generate buyer prompts, ask the
  engines, score recommendation, position, and share of voice into one AI
  Visibility Score. Needs at least one API key.
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
- `get_snapshot_diff` - compare two saved runs.

## Worked example

```bash
npx tsx src/cli/index.ts audit example.com
export OPENAI_API_KEY=...
npx tsx src/cli/index.ts check example.com --quick --yes
```

## Honesty and cost

BYO keys. Scores are estimates from sampling and say so; engines vary between
runs. Grounded engines (which cite sources) are reported separately from
parametric ones (which answer from model weights alone). Keys stay on the
user's machine and are never logged or stored.

Cost, measured on real runs (2026-07-20, `--quick` = 8 buyer prompts): the
zero-key `audit` is free; a single-engine `check` is about $0.09; all four
engines is $0.41 to $0.46; adding `--grounded` takes that to about $1.09,
since web search is billed on top of tokens. Every run reports what it spent,
split into setup and engine calls. `--max-cost` caps spend and is checked
before every call, but a call's cost is not known until it returns, so a run
can exceed the cap by at most one unmeasured call per engine; any overshoot is
always reported. Confirm the cost with the user before running `check` on a
large prompt pack or with `--grounded`.

SKU-level and product-feed checks are on the roadmap, not shipped.

More at optifeed.com
