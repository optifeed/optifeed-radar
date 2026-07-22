# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Please do not open a public issue for a security report.

Please include what you did, what happened, and what you expected. We aim to
acknowledge within 3 working days and to ship a fix or a mitigation plan within
14 days. This is a small open-source project, not a funded security program, so
those are targets rather than guarantees. Please give us a chance to fix an
issue before disclosing it publicly.

## What this tool does with your credentials

Optifeed Radar is BYO-key and runs entirely on your machine.

- API keys are read from the environment (or a local `.env`) and sent only to
  the provider each key belongs to: OpenAI, Anthropic, Google, Perplexity.
- Keys are never logged, never written to snapshots or reports, and never sent
  to any Optifeed service. There is no Optifeed backend in this tool.
- `config` reports only whether a key is present, never its value.
- All run state stays local, under `.optifeed/` in the working directory (the
  MCP server writes under your home directory instead). Snapshots and HTML
  reports contain the answers engines returned, so treat them as you would any
  other local file before sharing.

If you find a path where a key reaches a log line, a report, a snapshot, or a
third party, please treat it as a vulnerability and report it as above.

## Untrusted content

The tool fetches pages from the domain you point it at and sends prompts to AI
engines. Both are untrusted input:

- HTML report output escapes every piece of external text (page content, engine
  answers, citations), so fetched or generated markup cannot inject into the
  report.
- Engine answers are parsed as data, never executed.

## Supported versions

Only the latest published version receives fixes while the project is pre-1.0.
