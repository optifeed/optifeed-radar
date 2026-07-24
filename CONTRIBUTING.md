# Contributing to Optifeed Radar

Thanks for your interest in Optifeed Radar. It is an open-source AI visibility
checker (a CLI plus an MCP server) that asks real AI engines real buyer
questions and scores whether a brand gets recommended. Contributions are
welcome, whether that is a bug report, a doc fix, or code.

This is a small project, so a quick issue before a large change saves everyone
time. For anything beyond a typo or a one-line fix, please open an issue first
so we can agree on the approach.

## Ways to contribute

- **Report a bug.** Open an issue with what you ran, what happened, and what you
  expected. A minimal reproduction (the exact command and a fixture domain)
  helps a lot.
- **Suggest a feature.** Open an issue describing the problem you are trying to
  solve. Some capabilities (feed and catalog discovery, feed linting) are on the
  roadmap already, so it is worth checking open issues first.
- **Send a pull request.** See the workflow below.

Security issues are different: do not open a public issue. Follow
[SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.

## Development setup

You need Node 20 or newer.

```bash
git clone https://github.com/optifeed/optifeed-radar.git
cd optifeed-radar
npm install
```

The zero-key `audit` command runs with no API keys and no network calls to AI
engines, so it is the easiest thing to exercise while developing:

```bash
npm run dev -- audit example.com
```

The `check` pipeline needs at least one engine API key. Copy `.env.example` to
`.env` and add a key. Keys are read locally, sent only to the provider they
belong to, and never logged or committed. Never commit a `.env` file or paste a
key into an issue or PR.

## The checks that must pass

Every change has to pass the gate before it can merge:

```bash
npm run check          # typecheck + lint + test
npm run format:check   # prettier
npm run build          # must emit to dist/
```

`npm run check` is the same command CI runs. Please do not pipe it through
`tail` or similar when you check the result locally, because that can hide a
failing exit code.

## How we work

- **Tests come first.** This project is test-driven: write the failing test,
  watch it fail for the right reason, then write the minimal code to pass. A
  feature without failure-mode tests is not finished. Tests use fixtures and
  never hit the real network; inject the HTTP client, clock, or filesystem
  rather than calling out.
- **Keep the layers separate.** All logic lives in `src/core/`. The `src/cli/`
  and `src/mcp/` entrypoints are thin adapters over `src/core/run/`. Core code
  never imports from the CLI or MCP layers (a lint rule enforces this).
- **New dependencies need a reason.** If a change adds a dependency, justify it
  in the PR. We keep the dependency surface small on purpose.
- **Money goes through the cost guard.** Anything that spends on an AI engine
  estimates its cost first and respects `--max-cost`. Hitting the cap returns a
  flagged partial result rather than throwing.
- **Be honest in output.** Scores are estimates from sampling and say so.
  Partial runs surface what was skipped or capped rather than hiding it.

## Copy rules

User-facing text (README, help text, error messages, report footers) follows a
few house rules:

- The brand is "Optifeed", never "OptiFeed".
- Use "-", not em-dashes.
- Write "AI agents", not bare "agents".
- No invented metrics or false precision.
- Describe shipped, verified behavior in the present tense. Roadmap features are
  future tense.

## Pull request checklist

Before opening a PR:

- `npm run check`, `npm run format:check`, and `npm run build` are all green.
- New behavior has tests, including at least the failure modes.
- Commits are focused, and the PR description says what changed and why.
- User-facing text follows the copy rules above.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
