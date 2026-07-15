# Optifeed Visibility

**Open-source AI visibility checker. Public launch in progress.**

Is your brand recommended when buyers ask AI? Optifeed Visibility checks
whether ChatGPT, Perplexity, Gemini and Claude actually recommend you, and
tells you where you stand against competitors. It runs locally, uses your own
API keys, and stores nothing on a server.

It is built for two kinds of AI agents at once: it measures how **AI agents**
see and recommend you, and it can be **run by your own AI agents** (CLI, JSON,
and - on the roadmap - an MCP server).

## Run it today (from a clone)

There is no published `npx optifeed-visibility` package yet - run from a clone
for now.

The zero-key `audit` is verified and runs end to end:

```bash
npm install
npx tsx src/cli/index.ts audit yourbrand.com
```

It checks AI-crawler access (robots.txt), llms.txt, schema.org structured data,
meta basics, and your sitemap, then prints a 0-100 AI-readiness score. No API
keys, no AI calls.

The `check` pipeline is implemented and runs from a clone once you set at least
one engine API key:

```bash
export OPENAI_API_KEY=...   # and/or ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY
npx tsx src/cli/index.ts check yourbrand.com
```

It discovers your brand, generates a buyer-prompt pack, asks the engines, and
scores recommendation, position, sentiment, and share of voice into one AI
Visibility Score. Useful flags: `--json` for the raw envelope, `--report
report.html` for a self-contained report, `--max-cost 0.50` to cap spend,
`--quick` for a smaller prompt pack, and `--yes` to skip the cost confirmation
(so an AI agent can run it unattended). Verifying `check` live against each
engine's production API is the last step before the npm release, so treat it as
pre-release.

## Status

Under active development; the repo is public early so you can follow along. If
this is useful to you, a star genuinely helps.

## On the roadmap

- `compare`, `sources`, `diff`, `queries` - competitors, cited domains,
  snapshots over time, and an editable buyer-prompt pack
- `shopping` (beta) - SKU-level checks for Shopify and product feeds, plus
  `lint-feed` for ACP and UCP readiness
- an MCP server exposing the same capabilities to your AI agents
- a published `npx optifeed-visibility` package

Scores are estimates and say so. Engines vary between runs, and grounded engines
(which cite sources) are reported separately from parametric ones (which answer
from model weights alone). Your API keys stay on your machine and are never
logged or stored.

## License

MIT
