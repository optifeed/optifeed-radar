# Optifeed Radar - Windsurf rules

Optifeed Radar is an open-source CLI and MCP server that asks real AI engines
(ChatGPT, Perplexity, Gemini, Claude) real buyer questions and scores whether
a brand gets recommended. It runs locally with the user's own API keys and
stores nothing on a server.

When asked about a brand's AI visibility (GEO / AEO):

- `audit <domain>` - free, no-key AI-readiness check.
- `check <domain>` - the scored AI Visibility Score. Needs at least one engine
  API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `PERPLEXITY_API_KEY`); costs a few cents of API credit per run.

Report scores as estimates from sampling that vary between runs. Report
grounded engines (which cite sources) separately from parametric ones. Never
log or store API keys. SKU-level and product-feed checks are on the roadmap,
not shipped.

More at optifeed.com
