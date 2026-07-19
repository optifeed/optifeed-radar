# M16 - Agent Surfaces + README (Optifeed Radar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship launch #1's distribution artifacts - rename the package/CLI to `optifeed-radar`, add the agent-facing surfaces (SKILL.md, Claude Code plugin manifest, four per-platform ai-context files), rewrite the README under the "Optifeed Radar" name, and machine-check the copy with a messaging lint.

**Architecture:** Pure additive docs/config plus a mechanical rename of identity strings. The only executable code added lives under `test/` (a `messaging-rules` copy-lint helper + tests). No `src/core`, `src/cli`, or `src/mcp` logic changes beyond renaming identity string literals. No new dependencies. No changes to serialized envelopes, so no `schema_version` bump.

**Tech Stack:** TypeScript strict / ESM (NodeNext), Node >= 20, vitest, commander, `@modelcontextprotocol/sdk`. Distribution formats: Claude Code plugin manifest (`.claude-plugin/plugin.json`), Agent Skill (`SKILL.md`), Cursor MDC, plain-markdown context files.

---

## Design decisions locked (from the approved spec + research)

- **Product name = "Optifeed Radar"**; brand token stays `Optifeed` (never `OptiFeed`).
- **Package + CLI bin rename** `optifeed-visibility` -> `optifeed-radar`. The MCP bin `optifeed-mcp` and the `.optifeed/` state dir are unchanged.
- **Rename surface (verified by grep)** - all occurrences of the string `optifeed-visibility`:
  - `package.json` `name` and `bin` key
  - `src/cli/index.ts:55` commander `.name(...)`
  - `src/mcp/server.ts:20` MCP handshake identity `name`
  - `src/core/fetcher/fetcher.ts:73` crawler `userAgent` default
  - `src/core/fetcher/fetcher.test.ts:105,112` injected UA fixture
  - `test/cli.test.ts:16` program-name assertion
  - `CLAUDE.md` / `TASKS.md` product-name references (minimal) and the docs-repo `dev-plan.md` Global Decision
- **Version fields are NOT reconciled here.** `package.json` is `0.0.0`, `src/mcp/server.ts:20` hardcodes `0.1.0`. Leave both as-is (out of scope); M17 reconciles them at publish. `plugin.json` uses `0.1.0` to match the MCP handshake identity.
- **Skill location:** canonical skill at `skills/optifeed-radar/SKILL.md` (a directory the Claude Code plugin loader can bundle via `"skills": "./skills/"` and that ClawHub ingests as a standalone Agent Skill). No duplicate root `SKILL.md`. This refines the spec's "repo root" wording; noted in the module report.
- **Pre-release honest install framing:** the clone+build path leads (present-true); `npx`/npm invocation is documented but marked pending until M17 publishes.
- **Badges:** only the static MIT badge ships now (no repo slug needed). Build/stars/npm badges are listed in an HTML comment as "add at launch" - shipping placeholder `OWNER/REPO` slugs would render broken images, which is not honest.
- **Copy-lint** is a pure helper (`test/copy/messaging-rules.ts`) with red/green unit tests over known-bad inputs, plus an integration pass over the real surface files, plus a `JSON.parse` pass over every README ```` ```json ```` block. Uses `String.includes`, never regex (known regex-exec hook conflict).

## Verified facts the tasks depend on (quote-exact)

- Engine key env vars (`src/core/config.ts:11-14`): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (Gemini), `PERPLEXITY_API_KEY`.
- Footer CTA (`src/core/output/footer.ts:6`): `export const FOOTER_CTA = 'More at optifeed.com';` re-exported from `src/core/output/index.ts`.
- CLI commands: `audit`, `check`, `diff`, `sources`, `queries`, `config`.
- MCP tools (`src/mcp/tools.ts`): `check_visibility`, `audit_store`, `generate_buyer_queries`, `get_snapshot_diff`.
- MCP bin: `optifeed-mcp` -> `dist/mcp/index.js`. Node engines: `>=20`.

## File structure (created / modified)

**Created**
- `skills/optifeed-radar/SKILL.md` - Agent Skill card (ClawHub + Claude Code plugin).
- `.claude-plugin/plugin.json` - Claude Code plugin manifest (wires the stdio MCP server + bundles the skill).
- `ai-context/claude-project.md` - Claude Projects custom instructions.
- `ai-context/chatgpt-custom-gpt.md` - ChatGPT custom GPT instructions.
- `ai-context/cursor.mdc` - Cursor rules (MDC frontmatter).
- `ai-context/windsurf.md` - Windsurf rules.
- `test/copy/messaging-rules.ts` - pure copy-lint helper (banned substrings, roadmap gate, footer, json-block extractor).
- `test/copy/messaging-rules.test.ts` - red/green unit tests for the helper.
- `test/copy/surfaces.test.ts` - integration: run the helper over the real surface files + parse README json blocks.

**Modified**
- `README.md` - full rewrite.
- `package.json` - `name` + `bin` key.
- `src/cli/index.ts` - `.name(...)`.
- `src/mcp/server.ts` - handshake identity `name`.
- `src/core/fetcher/fetcher.ts` - `userAgent` default.
- `src/core/fetcher/fetcher.test.ts` - injected UA fixture.
- `test/cli.test.ts` - program-name assertion.
- `CLAUDE.md`, `TASKS.md` - product-name references (minimal).
- `/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md` - Global Decision package name.

---

### Task 1: Rename identity strings to `optifeed-radar`

**Files:**
- Modify: `test/cli.test.ts:16`
- Modify: `src/cli/index.ts:55`
- Modify: `package.json:2,23`
- Modify: `src/mcp/server.ts:20`
- Modify: `src/core/fetcher/fetcher.ts:73`
- Modify: `src/core/fetcher/fetcher.test.ts:105,112`

- [ ] **Step 1: Update the CLI program-name assertion (failing test first)**

In `test/cli.test.ts`, change line 16:

```ts
    expect(program.name()).toBe('optifeed-radar');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- cli`
Expected: FAIL - `test/cli.test.ts` "builds a named, versioned program" expects `'optifeed-radar'` but receives `'optifeed-visibility'`.

- [ ] **Step 3: Rename the commander program name**

In `src/cli/index.ts`, change line 55:

```ts
    .name('optifeed-radar')
```

- [ ] **Step 4: Rename the package name and CLI bin key**

In `package.json`, change line 2:

```json
  "name": "optifeed-radar",
```

and the `bin` block (lines 22-25) - rename ONLY the CLI key, keep `optifeed-mcp`:

```json
  "bin": {
    "optifeed-radar": "dist/cli/index.js",
    "optifeed-mcp": "dist/mcp/index.js"
  },
```

- [ ] **Step 5: Rename the MCP handshake identity**

In `src/mcp/server.ts`, change line 20 (rename `name` only; leave `version: '0.1.0'`):

```ts
    { name: 'optifeed-radar', version: '0.1.0' },
```

- [ ] **Step 6: Rename the crawler User-Agent default**

In `src/core/fetcher/fetcher.ts`, change line 73:

```ts
  userAgent: 'optifeed-radar',
```

- [ ] **Step 7: Update the injected UA fixture in the fetcher test**

In `src/core/fetcher/fetcher.test.ts`, change lines 105 and 112:

```ts
      userAgent: 'optifeed-radar/9.9.9',
```

```ts
    expect(seen[0]?.['user-agent']).toBe('optifeed-radar/9.9.9');
```

- [ ] **Step 8: Verify no stray old name remains in code**

Run: `grep -rn "optifeed-visibility" src test package.json`
Expected: no matches (empty output, exit code 1 from grep is fine here).

- [ ] **Step 9: Run the full gate**

Run: `npm run check`
Expected: PASS (typecheck + lint + all tests green).

- [ ] **Step 10: Build and confirm the renamed bin emits**

Run: `npm run build && node dist/cli/index.js --help`
Expected: build emits to `dist/`; `--help` header shows `Usage: optifeed-radar ...`.

- [ ] **Step 11: Commit**

```bash
git add package.json src/cli/index.ts src/mcp/server.ts src/core/fetcher/fetcher.ts src/core/fetcher/fetcher.test.ts test/cli.test.ts
git commit -m "M16: rename package + CLI bin to optifeed-radar

Renames the npm package name, the CLI bin key, the commander program
name, the MCP handshake identity, and the crawler User-Agent from
optifeed-visibility to optifeed-radar. MCP bin (optifeed-mcp) and the
.optifeed/ state dir are unchanged. Version fields are left as-is
(reconciled at M17 publish).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Copy-lint helper + red/green unit tests

The docs module's real risk surface is copy correctness, so the failure-mode coverage is a messaging lint. Build the pure helper first with unit tests over known-bad inputs (this is the red/green TDD core), then Task 8 runs it over the real files.

**Files:**
- Create: `test/copy/messaging-rules.ts`
- Test: `test/copy/messaging-rules.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `test/copy/messaging-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  extractJsonBlocks,
  findMessagingViolations,
} from './messaging-rules.js';

describe('findMessagingViolations', () => {
  it('flags an em-dash', () => {
    const v = findMessagingViolations('Optifeed Radar - fast — honest', {});
    expect(v.some((m) => m.includes('em-dash'))).toBe(true);
  });

  it('flags the OptiFeed mis-casing but not correct Optifeed', () => {
    expect(
      findMessagingViolations('OptiFeed Radar', {}).some((m) =>
        m.includes('OptiFeed'),
      ),
    ).toBe(true);
    expect(findMessagingViolations('Optifeed Radar', {})).toHaveLength(0);
  });

  it('flags free-vs-paid equivalence framing', () => {
    const v = findMessagingViolations('Get paid tools for free here', {});
    expect(v.some((m) => m.includes('free-vs-paid'))).toBe(true);
  });

  it('flags present-tense Shopping claims', () => {
    const v = findMessagingViolations('Optifeed Shopping checks your SKUs', {
      enforceRoadmapGate: true,
    });
    expect(v.some((m) => m.includes('roadmap'))).toBe(true);
  });

  it('requires a waitlist when Shopping is mentioned under the gate', () => {
    const v = findMessagingViolations('Optifeed Shopping is coming later', {
      enforceRoadmapGate: true,
    });
    expect(v.some((m) => m.includes('waitlist'))).toBe(true);
  });

  it('passes clean roadmap copy that gates on a waitlist', () => {
    const ok =
      'Optifeed Shopping will extend this later - join the waitlist at optifeed.com';
    expect(
      findMessagingViolations(ok, { enforceRoadmapGate: true }),
    ).toHaveLength(0);
  });

  it('requires the footer CTA when asked', () => {
    expect(
      findMessagingViolations('no cta here', { requireFooter: true }).some(
        (m) => m.includes('footer'),
      ),
    ).toBe(true);
    expect(
      findMessagingViolations('ends with More at optifeed.com', {
        requireFooter: true,
      }),
    ).toHaveLength(0);
  });
});

describe('extractJsonBlocks', () => {
  it('pulls fenced json blocks and ignores bash blocks', () => {
    const md = [
      '```bash',
      'npm install',
      '```',
      '```json',
      '{ "a": 1 }',
      '```',
    ].join('\n');
    const blocks = extractJsonBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0])).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- messaging-rules`
Expected: FAIL - `Cannot find module './messaging-rules.js'` (helper not written yet).

- [ ] **Step 3: Write the helper**

Create `test/copy/messaging-rules.ts`:

```ts
import { FOOTER_CTA } from '../../src/core/output/index.js';

export interface MessagingRuleOptions {
  /** Enforce that roadmap (Shopping) copy stays future-tense + waitlist-gated. */
  enforceRoadmapGate?: boolean;
  /** Require the single footer CTA to be present. */
  requireFooter?: boolean;
}

/** Substrings that must never appear in customer-facing copy. */
const BANNED: { needle: string; label: string; caseInsensitive?: boolean }[] = [
  { needle: '—', label: 'em-dash (use "-" instead)' },
  { needle: 'OptiFeed', label: 'OptiFeed mis-casing (brand is "Optifeed")' },
  {
    needle: 'paid tools for free',
    label: 'free-vs-paid equivalence framing',
    caseInsensitive: true,
  },
  {
    needle: 'free alternative to paid',
    label: 'free-vs-paid equivalence framing',
    caseInsensitive: true,
  },
];

/** Present-tense Shopping claims - Shopping is roadmap (future tense only). */
const ROADMAP_PRESENT_TENSE = [
  'shopping checks',
  'shopping supports',
  'shopping scores',
  'now supports sku',
];

export function findMessagingViolations(
  text: string,
  opts: MessagingRuleOptions,
): string[] {
  const violations: string[] = [];
  const lower = text.toLowerCase();

  for (const rule of BANNED) {
    const hay = rule.caseInsensitive ? lower : text;
    const needle = rule.caseInsensitive ? rule.needle.toLowerCase() : rule.needle;
    if (hay.includes(needle)) violations.push(`banned: ${rule.label}`);
  }

  if (opts.enforceRoadmapGate && lower.includes('shopping')) {
    for (const phrase of ROADMAP_PRESENT_TENSE) {
      if (lower.includes(phrase)) {
        violations.push(`roadmap: present-tense Shopping claim ("${phrase}")`);
      }
    }
    if (!lower.includes('waitlist')) {
      violations.push('waitlist: Shopping mentioned without a waitlist gate');
    }
  }

  if (opts.requireFooter && !text.includes(FOOTER_CTA)) {
    violations.push(`footer: missing CTA "${FOOTER_CTA}"`);
  }

  return violations;
}

/** Extract the contents of every ```json fenced block. No regex (hook-safe). */
export function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const parts = markdown.split('```json');
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf('```');
    if (end !== -1) blocks.push(parts[i].slice(0, end));
  }
  return blocks;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- messaging-rules`
Expected: PASS (all cases in `messaging-rules.test.ts` green).

- [ ] **Step 5: Commit**

```bash
git add test/copy/messaging-rules.ts test/copy/messaging-rules.test.ts
git commit -m "M16: copy-lint helper for the messaging guide (red/green)

Pure findMessagingViolations() + extractJsonBlocks() with unit tests
over known-bad inputs (em-dash, OptiFeed mis-casing, free-vs-paid,
present-tense Shopping, missing footer). String.includes only, no
regex. The surface integration pass lands with the written copy.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SKILL.md (Agent Skill card)

**Files:**
- Create: `skills/optifeed-radar/SKILL.md`

- [ ] **Step 1: Write the skill card**

Create `skills/optifeed-radar/SKILL.md`:

```markdown
---
name: optifeed-radar
description: Check whether AI engines (ChatGPT, Perplexity, Gemini, Claude) recommend a brand when buyers ask, and score its AI visibility. Use when someone asks "does AI recommend my brand", wants an AI visibility / GEO / AEO check, or wants to audit a site's AI-readiness. Runs locally with the user's own engine API keys. The zero-key audit is free; the check pipeline spends a few cents of the user's API credit per run.
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
user's machine and are never logged or stored. The zero-key `audit` costs
nothing; a `--quick` single-engine `check` costs roughly a few cents of the
user's API credit (about $0.09 measured on one run, varies by engine and
prompt-pack size). SKU-level and product-feed checks are on the roadmap, not
shipped.

More at optifeed.com
```

- [ ] **Step 2: Verify frontmatter and footer**

Run: `head -5 skills/optifeed-radar/SKILL.md`
Expected: a `---` fenced YAML block with `name: optifeed-radar` and a `description:` line. Confirm the body ends with `More at optifeed.com` (the footer CTA).

- [ ] **Step 3: Commit**

```bash
git add skills/optifeed-radar/SKILL.md
git commit -m "M16: Optifeed Radar Agent Skill card (SKILL.md)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Claude Code plugin manifest

The MCP command uses `node` + `${CLAUDE_PLUGIN_ROOT}` so it does not depend on
a shebang in the built bin. It assumes the plugin has been built (`npm run
build`) - honest for a pre-release, clone-installed plugin.

**Files:**
- Create: `.claude-plugin/plugin.json`

- [ ] **Step 1: Write the manifest**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "optifeed-radar",
  "displayName": "Optifeed Radar",
  "version": "0.1.0",
  "description": "Ask real AI engines real buyer questions and score whether a brand gets recommended. CLI plus an MCP server, running locally with your own API keys.",
  "author": {
    "name": "Optifeed",
    "url": "https://optifeed.com"
  },
  "homepage": "https://optifeed.com",
  "license": "MIT",
  "skills": "./skills/",
  "mcpServers": {
    "optifeed-radar": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js"]
    }
  }
}
```

- [ ] **Step 2: Verify it is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "M16: Claude Code plugin manifest (stdio MCP + bundled skill)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Per-platform ai-context files

Four compact context blocks, each tuned to its platform. All four end with the
footer CTA and follow the copy rules (no em-dash, "AI agents", future-tense
roadmap).

**Files:**
- Create: `ai-context/claude-project.md`
- Create: `ai-context/chatgpt-custom-gpt.md`
- Create: `ai-context/cursor.mdc`
- Create: `ai-context/windsurf.md`

- [ ] **Step 1: Write `ai-context/claude-project.md`**

```markdown
# Optifeed Radar - Claude Project instructions

Paste this into a Claude Project's custom instructions to make the project an
Optifeed Radar operator.

Optifeed Radar is an open-source CLI and MCP server that asks real AI engines
(ChatGPT, Perplexity, Gemini, Claude) real buyer questions and scores whether
a brand gets recommended. It runs locally with the user's own API keys and
stores nothing on a server.

When the user asks whether AI recommends their brand, or wants an AI
visibility / GEO / AEO check:

- For a free, no-key readiness pass, run `audit <domain>` (CLI) or the
  `audit_store` MCP tool.
- For the scored visibility check, run `check <domain>` (CLI) or the
  `check_visibility` MCP tool. It needs at least one engine API key
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `PERPLEXITY_API_KEY`) and spends a few cents of the user's API credit.

Report scores as estimates from sampling; engines vary between runs. Report
grounded engines (which cite sources) separately from parametric ones. Never
print or store API keys. SKU-level and product-feed checks are on the roadmap,
not shipped.

More at optifeed.com
```

- [ ] **Step 2: Write `ai-context/chatgpt-custom-gpt.md`**

```markdown
# Optifeed Radar - ChatGPT custom GPT instructions

Paste this into a custom GPT's instructions.

You help users check whether AI engines recommend their brand using Optifeed
Radar, an open-source CLI and MCP server that asks real AI engines real buyer
questions and scores AI visibility. It runs locally with the user's own API
keys and stores nothing on a server.

Guide the user to:

- Run `audit <domain>` for a free, no-key AI-readiness check.
- Run `check <domain>` for the scored AI Visibility Score. It needs at least
  one engine API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `PERPLEXITY_API_KEY`) and costs a few cents of the user's API credit per run.

Always describe scores as estimates from sampling that vary between runs.
Report grounded engines (which cite sources) separately from parametric ones.
Never ask the user to paste API keys into the chat - keys stay on their
machine. SKU-level and product-feed checks are on the roadmap, not shipped.

More at optifeed.com
```

- [ ] **Step 3: Write `ai-context/cursor.mdc`**

```markdown
---
description: Use Optifeed Radar to check whether AI engines recommend a brand (AI visibility / GEO / AEO)
globs:
alwaysApply: false
---

# Optifeed Radar

Optifeed Radar is an open-source CLI and MCP server that asks real AI engines
(ChatGPT, Perplexity, Gemini, Claude) real buyer questions and scores whether
a brand gets recommended. It runs locally with the user's own API keys.

- `audit <domain>` - free, no-key AI-readiness check.
- `check <domain>` - the scored AI Visibility Score. Needs at least one engine
  API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `PERPLEXITY_API_KEY`); costs a few cents of API credit per run.

Scores are estimates from sampling and vary between runs. Grounded engines are
reported separately from parametric ones. Never log or store API keys.
SKU-level and product-feed checks are on the roadmap, not shipped.

More at optifeed.com
```

- [ ] **Step 4: Write `ai-context/windsurf.md`**

```markdown
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
```

- [ ] **Step 5: Verify all four exist and carry the footer**

Run: `grep -L "More at optifeed.com" ai-context/*.md ai-context/*.mdc`
Expected: no output (every file contains the footer CTA; `grep -L` lists files that lack it).

- [ ] **Step 6: Commit**

```bash
git add ai-context/
git commit -m "M16: per-platform ai-context files (Claude, ChatGPT, Cursor, Windsurf)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: README rewrite

Full rewrite under the Optifeed Radar name, pre-release honest. Every ```` ```json ```` block must be valid JSON (Task 8 parses them). MCP config paths use a `/path/to/optifeed-radar` placeholder the user replaces.

**Files:**
- Modify: `README.md` (replace entire contents)

- [ ] **Step 1: Replace `README.md` with the full rewrite**

````markdown
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
export OPENAI_API_KEY=...   # and/or ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY
npx tsx src/cli/index.ts check yourbrand.com
```

It discovers your brand, generates a buyer-prompt pack, asks the engines, and
scores recommendation, position, and share of voice into one AI Visibility
Score. The score reads only the unbranded buyer questions (did the AI surface
you unprompted); questions that name your brand are reported separately as
reputation. Verifying `check` live against each engine's production API is the
last step before the npm release, so treat it as pre-release.

The examples call `npx tsx src/cli/index.ts` directly so flags reach the CLI
unchanged. With the `npm run dev` script, put `--` before the arguments
(`npm run dev -- check yourbrand.com --report out.html`).

## What it does

Optifeed Radar asks real AI engines real buyer questions and measures whether
your brand gets recommended - not whether you rank in a search index, but
whether the answer an AI gives a buyer names you. Grounded engines (which cite
web sources) are reported separately from parametric ones (which answer from
model weights alone), because they behave differently.

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

| Surface | Name | What it does | Cost |
| --- | --- | --- | --- |
| CLI | `audit` | Zero-key AI-readiness check (robots, llms.txt, schema, sitemap) | Free, no AI calls |
| CLI | `check` | Full pipeline: buyer prompts, engines, AI Visibility Score | BYO keys |
| CLI | `diff` | What changed between your last two runs | Free (reads a saved snapshot) |
| CLI | `sources` | Domains the AI cited, and your share of voice | Free (reads a saved snapshot) |
| CLI | `queries` | Show or export your buyer-prompt pack | Free |
| CLI | `config` | Which engine keys are set, where state is stored | Free |
| MCP | `check_visibility` | Run a visibility check for a domain | BYO keys |
| MCP | `audit_store` | Run the zero-key readiness audit | Free |
| MCP | `generate_buyer_queries` | Produce the buyer-prompt pack | Free |
| MCP | `get_snapshot_diff` | Compare two saved runs | Free |

Cost transparency: `audit` queries no AI engines and costs nothing. `check`
spends your own API credit - a `--quick` single-engine run costs roughly a few
cents (about $0.09 measured on one run; your cost varies by engine,
prompt-pack size, and provider pricing). Cap spend with `--max-cost 0.50`;
hitting the cap returns a partial result flagged as capped, never an error.

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
`check` pipeline spends your own engine API credit - a few cents for a quick
run. You bring your own keys; there is no Optifeed-hosted billing.

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
````

- [ ] **Step 2: Verify the footer and JSON blocks by eye**

Run: `tail -3 README.md`
Expected: the file ends with `More at optifeed.com`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "M16: README rewrite as Optifeed Radar (pre-release honest)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Surface integration lint + config-block parse test

Now that the real surfaces exist, run the Task 2 helper over them and parse
every README json block. This is the module's completeness gate.

**Files:**
- Test: `test/copy/surfaces.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/copy/surfaces.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractJsonBlocks,
  findMessagingViolations,
  type MessagingRuleOptions,
} from './messaging-rules.js';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

const SURFACES: { file: string; opts: MessagingRuleOptions }[] = [
  { file: 'README.md', opts: { enforceRoadmapGate: true, requireFooter: true } },
  { file: 'skills/optifeed-radar/SKILL.md', opts: { requireFooter: true } },
  { file: 'ai-context/claude-project.md', opts: { requireFooter: true } },
  { file: 'ai-context/chatgpt-custom-gpt.md', opts: { requireFooter: true } },
  { file: 'ai-context/cursor.mdc', opts: { requireFooter: true } },
  { file: 'ai-context/windsurf.md', opts: { requireFooter: true } },
  { file: '.claude-plugin/plugin.json', opts: {} },
];

describe('surface copy passes the messaging lint', () => {
  for (const { file, opts } of SURFACES) {
    it(`${file} has no messaging violations`, () => {
      expect(findMessagingViolations(read(file), opts)).toEqual([]);
    });
  }
});

describe('README config blocks are valid JSON', () => {
  it('every json block parses', () => {
    const blocks = extractJsonBlocks(read('README.md'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- surfaces`
Expected: PASS. If any surface fails the lint, FIX THE COPY in that file (not the test) - a violation is a real copy bug. Re-run until green.

- [ ] **Step 3: Full gate**

Run: `npm run check && npm run format:check`
Expected: both green. If prettier rewrites anything, run `npm run format` and re-stage.

- [ ] **Step 4: Commit**

```bash
git add test/copy/surfaces.test.ts
git commit -m "M16: integration lint over surfaces + README json-block parse

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs sync + live MCP handshake verification

Finish the rename across the human docs, reconcile the plan-first rule, and
prove the renamed MCP server still handshakes.

**Files:**
- Modify: `CLAUDE.md` (product-name references, minimal)
- Modify: `TASKS.md` (M16 status)
- Modify: `/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md` (Global Decision package name)

- [ ] **Step 1: Update `CLAUDE.md` H1 and intro to Optifeed Radar**

Change the H1 from `# CLAUDE.md - Optifeed Visibility` to
`# CLAUDE.md - Optifeed Radar`, and update the opening sentence's product name
to "Optifeed Radar". Do NOT change the brand token "Optifeed" elsewhere, the
scope section, or the hard rules. Note the package is now `optifeed-radar`
where the file names the package.

- [ ] **Step 2: Update `TASKS.md`**

Mark M16 as done with a one-line summary (rename + surfaces + README +
copy-lint), matching the tracker's existing entry style. Note that M17 must
flip npm/npx copy to present tense, add the launch badges, and file the
directory-listing PRs.

- [ ] **Step 3: Update the docs-repo Global Decision**

In `/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md`, find the Global
Decision pinning the package name `optifeed-visibility` and change it to
`optifeed-radar`, with a dated note that M16 performed the rename. If that path
is not accessible in the session, STOP and ask the user rather than guessing.

- [ ] **Step 4: Rebuild and verify the MCP stdio handshake under the new name**

Run:
```bash
npm run build
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node dist/mcp/index.js
```
Expected: a single JSON-RPC response whose `result.serverInfo.name` is
`optifeed-radar`. (If the server needs a `notifications/initialized` follow-up
or waits on stdin, Ctrl-C after the first response line is fine - we only need
the identity echoed.)

- [ ] **Step 5: Confirm no stray old name anywhere**

Run: `grep -rn "optifeed-visibility" . --include='*.ts' --include='*.json' --include='*.md' --exclude-dir=node_modules --exclude-dir=dist`
Expected: no matches except, if present, the historical review-log lines in
`TASKS.md` / plan files that quote past commits - leave those.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md TASKS.md
git commit -m "M16: sync product-name docs to Optifeed Radar; log module done

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Commit the docs-repo change separately in that repo:

```bash
git -C /Users/erdem/workspace/optifeed-radar-docs add dev-plan.md
git -C /Users/erdem/workspace/optifeed-radar-docs commit -m "dev-plan: package renamed to optifeed-radar (M16)"
```

---

## Definition of done (verify all before declaring complete)

- [ ] `npm run check` green (typecheck + lint + full vitest, including
  `messaging-rules`, `surfaces`, and `cli` tests).
- [ ] `npm run format:check` clean; `npm run build` emits `dist/`.
- [ ] `grep -rn "optifeed-visibility" src test package.json` returns nothing.
- [ ] `.claude-plugin/plugin.json` and every README ```` ```json ```` block
  parse as JSON.
- [ ] SKILL.md has valid `name` + `description` frontmatter; all surfaces end
  with the `FOOTER_CTA`.
- [ ] MCP stdio handshake echoes `serverInfo.name = optifeed-radar`.
- [ ] PR body ends with a `## Module report`: what shipped, the wider-than-spec
  rename surface (MCP identity + User-Agent), the skill-at-`skills/` refinement,
  and the M17 follow-ups (npm/npx present tense, launch badges, listing PRs,
  version reconciliation `0.0.0` vs `0.1.0`).

## Manual checklist (not machine-checked - judgment calls)

- Bare "agents" vs "AI agents": scan every surface; the lint does not catch this.
- Voice: would each README section survive a skeptical Hacker News reader? No
  invented metrics, no fake precision, no "paid tools for free" framing.
- Grounded vs parametric kept distinct wherever scoring is described.

## Out of scope

Hosted/landing pages, actual directory-submission PRs, the npm publish, badges
going live, any Shopping present-tense copy, and version-field reconciliation -
all M17.
