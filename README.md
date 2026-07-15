# Optifeed Visibility

**Open-source AI visibility checker. Launching soon.**

Is your brand recommended when buyers ask AI? Optifeed Visibility checks
whether ChatGPT, Perplexity, Gemini and Claude actually recommend you, and
tells you where you stand against competitors. It runs locally, uses your own
API keys, and stores nothing on a server.

It is built for two kinds of agents at once: it measures how **AI agents** see
and recommend you, and it can be **run by your own agent** (CLI, JSON, and an
MCP server).

```bash
# coming soon
npx optifeed-visibility check yourbrand.com
```

## Status

Under active development. The repo is public early so you can follow along.
If this is useful to you, a star genuinely helps.

## What it will do

- `audit` - instant, zero-key static AI-readiness check (robots.txt AI-crawler
  rules, llms.txt, schema.org)
- `check` - ask real engines your buyers' questions and score recommendation,
  position, sentiment, and share of voice
- `compare`, `sources`, `diff`, `queries` - competitors, cited domains,
  snapshots over time, and an editable buyer-prompt pack
- `shopping` (beta) - SKU-level checks for Shopify and product feeds, plus
  `lint-feed` for ACP and UCP readiness
- an MCP server exposing the same capabilities to your AI agents

Scores are estimates and say so. Engines vary between runs. Your API keys stay
on your machine and are never logged or stored.

## License

MIT
