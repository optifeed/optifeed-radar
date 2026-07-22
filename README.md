# Optifeed Radar

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<!-- Build, stars, npm version, and npm downloads badges are added at launch
(M17), once the public repo slug and the published package exist. Shipping
placeholder badges now would render broken images. -->

**Open-source AI visibility checker. Public launch in progress.**

Is your brand recommended when buyers ask AI? Optifeed Radar checks whether
ChatGPT, Perplexity, Gemini and Claude actually recommend you, and tells you
where you stand against competitors. It runs locally, uses your own API keys,
and stores nothing on a server.

It is built for two kinds of AI agents at once: it measures how **AI agents**
see and recommend you, and it can be **run by your own AI agents** (CLI, JSON,
and an MCP server). People also call this AI visibility, generative engine
optimization (GEO), answer engine optimization (AEO), or AI-SEO.

## 60-second setup (from a clone)

The npm package is not published yet, so run from a clone for now. Published
`npx optifeed-radar` lands at launch.

The zero-key `audit` is verified and runs end to end - no API keys, no AI calls:

```bash
npm install
npx tsx src/cli/index.ts audit yourbrand.com
```

It checks AI-crawler access (robots.txt), llms.txt, schema.org structured
data, meta basics, and your sitemap, then prints a 0-100 AI-readiness score.

The `check` pipeline runs from a clone once you set at least one engine API key:

```bash
cp .env.example .env        # then put at least one key in it
npx tsx src/cli/index.ts check yourbrand.com
```

The CLI loads `.env` from the directory you run it in, so there is no shell
setup step. Exporting the keys works too (`export OPENAI_API_KEY=...`), and an
exported key always wins over the same key in `.env`. `config` shows which
keys were found and which file they came from, never the values.

It discovers your brand, generates a buyer-prompt pack, asks the engines, and
scores recommendation, position, and share of voice into one AI Visibility
Score. The score reads only the unbranded buyer questions (did the AI surface
you unprompted); questions that name your brand are reported separately as
reputation. All four engines are verified live against their production APIs
(2026-07-20). Treat this as pre-release only because the npm package is not
published yet.

The examples call `npx tsx src/cli/index.ts` directly so flags reach the CLI
unchanged. With the `npm run dev` script, put `--` before the arguments
(`npm run dev -- check yourbrand.com --report out.html`).

## What it does

Optifeed Radar asks real AI engines real buyer questions and measures whether
your brand gets recommended - not whether you rank in a search index, but
whether the answer an AI gives a buyer names you. Grounded engines (which cite
web sources) are reported separately from parametric ones (which answer from
model weights alone), because they behave differently. An engine counts as
grounded only for the answers where it actually searched: asking for grounded
mode is a request a model can decline, so the report says when an engine
searched on only some of its answers. METHODOLOGY.md has the formula.

## Use it from your AI agents (MCP)

The `optifeed-mcp` server exposes the same capability to AI agents. It runs
over stdio. Build first (`npm install && npm run build`), then point your
client at `dist/mcp/index.js`. Replace `/path/to/optifeed-radar` with your
clone path.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "optifeed-radar": {
      "command": "node",
      "args": ["/path/to/optifeed-radar/dist/mcp/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Claude Code (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "optifeed-radar": {
      "command": "node",
      "args": ["/path/to/optifeed-radar/dist/mcp/index.js"]
    }
  }
}
```

Cursor (`.cursor/mcp.json`) and Windsurf (`mcp_config.json`) use the same
shape:

```json
{
  "mcpServers": {
    "optifeed-radar": {
      "command": "node",
      "args": ["/path/to/optifeed-radar/dist/mcp/index.js"]
    }
  }
}
```

At launch the published package will also run via npx (no clone needed):

```json
{
  "mcpServers": {
    "optifeed-radar": {
      "command": "npx",
      "args": ["-y", "--package=optifeed-radar", "optifeed-mcp"]
    }
  }
}
```

## Tools and cost

| Surface | Name                     | What it does                                                    | Cost                          |
| ------- | ------------------------ | --------------------------------------------------------------- | ----------------------------- |
| CLI     | `audit`                  | Zero-key AI-readiness check (robots, llms.txt, schema, sitemap) | Free, no AI calls             |
| CLI     | `check`                  | Full pipeline: buyer prompts, engines, AI Visibility Score      | BYO keys                      |
| CLI     | `diff`                   | What changed between your last two runs                         | Free (reads a saved snapshot) |
| CLI     | `sources`                | Domains the AI cited, and your share of voice                   | Free (reads a saved snapshot) |
| CLI     | `queries`                | Show or export your buyer-prompt pack                           | Free                          |
| CLI     | `config`                 | Which engine keys are set, where state is stored                | Free                          |
| MCP     | `check_visibility`       | Run a visibility check for a domain                             | BYO keys                      |
| MCP     | `audit_store`            | Run the zero-key readiness audit                                | Free                          |
| MCP     | `generate_buyer_queries` | Produce the buyer-prompt pack                                   | Free                          |
| MCP     | `get_snapshot_diff`      | Compare two saved runs                                          | Free                          |

Cost transparency: `audit` queries no AI engines and costs nothing. `check`
spends your own API credit. Measured on real runs (2026-07-20, `--quick` =
8 buyer prompts):

| run                              | measured cost  |
| -------------------------------- | -------------- |
| `audit`                          | free           |
| `check --quick`, one engine      | about $0.09    |
| `check --quick`, all four        | $0.41 to $0.46 |
| `check --quick --grounded`, four | about $1.09    |

Your cost varies with engine, prompt-pack size, and provider pricing. Grounded
runs cost roughly 3x parametric ones, because web search is billed on top of
tokens: Google charges per search query, and one answer can trigger several.

How long it takes, measured the same way (2026-07-22):

| run                              | measured time      |
| -------------------------------- | ------------------ |
| first `npx` (install, once)      | about 8 seconds    |
| `audit`                          | 0.3 to 1.7 seconds |
| `check --quick`, four engines    | 47 to 51 seconds   |
| `check --quick --grounded`, four | about 97 seconds   |

The install figure was measured from the packed tarball with an empty npm
cache, so once the package is published a cold
`npx optifeed-radar audit yourbrand.com` should finish in about ten seconds
(re-verified against the registry at publish). A `check` takes as long as the
engines take to answer: it queries
several of them across a whole prompt pack, and that wait is provider latency
we do not control. `check` reports live progress while it runs, so you can see
which phase it is in rather than watching a blank terminal.

Every run reports what it actually spent, split into setup (brand discovery
and prompt generation) and engine calls, so you can reconcile it against your
provider bill. Declining at the confirmation prompt still reports the setup
cost, because discovery runs before that prompt.

`--max-cost 0.20` caps spend. The cap is checked before every call and hitting
it returns a partial result flagged as capped, never an error. It is a strong
bound rather than an absolute ceiling: an engine's cost is not known until its
call returns, so a run can exceed the cap by at most the cost of one
unmeasured call per engine. Any overshoot is always reported, never hidden.

Useful `check` flags: `--json` (raw envelope), `--report report.html`
(self-contained report), `--max-cost 0.50`, `--quick` (smaller prompt pack),
`--grounded` (web-search mode where engines support it), `--fail-under 50`
(exit non-zero below a threshold, for CI), `--yes` (skip the cost prompt so an
AI agent can run it unattended).

## Example

```bash
npx tsx src/cli/index.ts audit example.com      # free readiness score
npx tsx src/cli/index.ts check example.com --quick --yes
npx tsx src/cli/index.ts diff example.com        # what changed since last run
npx tsx src/cli/index.ts sources example.com     # who the AI cited
npx tsx src/cli/index.ts config                  # which keys are set
```

`config` reports only whether each key is present, never the key value.

## FAQ

**What is AI visibility?** Whether AI engines recommend your brand when a buyer
asks them a question, rather than whether you rank in a traditional search
index. It is also called generative engine optimization (GEO) or answer engine
optimization (AEO).

**Is there an MCP server?** Yes. The `optifeed-mcp` server exposes
`check_visibility`, `audit_store`, `generate_buyer_queries`, and
`get_snapshot_diff` to your AI agents over stdio.

**What does it cost?** The `audit` command is free and needs no keys. The
`check` pipeline spends your own engine API credit: measured at about $0.09 for
a quick single-engine run, $0.41 to $0.46 across all four, and about $1.09 with
`--grounded`. Every run reports what it spent, and `--max-cost` caps it. You
bring your own keys; there is no Optifeed-hosted billing.

**Is my data stored anywhere?** No. It runs locally, saves snapshots on your
machine, and never sends your API keys off-device or logs them.

**Which engines does it support?** OpenAI (ChatGPT), Anthropic (Claude), Google
(Gemini), and Perplexity. Set any one key to start; set more for broader
coverage.

**How is the score computed?** From sampling real engine answers to unbranded
buyer questions, scoring recommendation, position, and share of voice. Scores
are estimates and vary between runs. See METHODOLOGY.md for the full method.

## For directory maintainers

One-liners for awesome-mcp-servers, ClawHub, and Smithery listings:

- **Optifeed Radar** - Ask real AI engines real buyer questions and score
  whether a brand gets recommended. CLI plus MCP server, runs locally, BYO keys.
- **Optifeed Radar (MCP)** - `check_visibility`, `audit_store`,
  `generate_buyer_queries`, and `get_snapshot_diff` for measuring brand AI
  visibility (GEO / AEO) from your AI agents.

Search intents this serves: AI visibility checker, does AI recommend my brand,
generative engine optimization (GEO) tool, answer engine optimization (AEO),
ChatGPT brand visibility, AI-SEO, MCP server for brand visibility.

## What this does NOT do

- It is a point-in-time check, not continuous monitoring.
- Scores are estimates from sampling and vary between runs - they are not a
  guaranteed ranking.
- It does not check SKU-level product visibility or product feeds yet.
- `check` spends your own API credit; only `audit` is free.
- It is not a traditional SEO rank tracker.

Optifeed Shopping will extend this to SKU-level visibility and product-feed
checks against the Agentic Commerce Protocol (ACP) and the Universal Commerce
Protocol (UCP). It is a separate, later release - join the waitlist at
optifeed.com.

## Status

Under active development; the repo is public early so you can follow along. If
this is useful to you, a star genuinely helps. Scores are estimates and say so.
Your API keys stay on your machine and are never logged or stored.

## License

MIT

More at optifeed.com
