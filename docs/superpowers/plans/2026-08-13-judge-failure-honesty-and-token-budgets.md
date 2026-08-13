# Judge Failure Honesty and Reasoning Token Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failed or starved judge call impossible to mistake for a successful one, and stop reasoning judges from silently returning nothing.

**Architecture:** Three defects share one shape: a judge call produces nothing and the tool reports that as a normal, empty result. We fix them at the layer each belongs to. (1) A shared `judgeMaxTokens` helper in `core/costs.ts` sizes every judge cap with reasoning headroom, so a thinking model can never spend the whole budget before its first answer token. (2) `core/queries` and `core/discovery` report an empty or unusable judge response as a skip reason instead of an empty result. (3) `core/run` refuses to reach the cost-confirmation gate with zero prompts, and the CLI prints the reason it already receives but throws away. The Gemini adapter's `thinkingBudget: 0` workaround is removed last, because it only becomes safe to remove once (1) has landed.

**Tech Stack:** TypeScript strict, ESM/NodeNext, vitest, commander. No new dependencies.

---

## Background: the evidence behind this plan

All measured live on 2026-08-13 against the real provider APIs. Quote these numbers in comments; they are the reason the constants have the values they do.

| Observation | Evidence |
| --- | --- |
| The reported bug: `check bcombinator.com` produced 0 prompts | `generateQueries` returned `skipped: "judge error: HTTP 429 ... credit_balance_exhausted"`. The CLI printed `✓ Generated 0 buyer prompts` and never showed the note. |
| Reasoning tokens draw from the same budget as the answer | `claude-sonnet-5`, M5 generation prompt, `max_tokens: 1440` → `stop_reason: max_tokens`, `thinking_tokens: 1440`, content blocks `[thinking]`, text length **0**. At `max_tokens: 8000` the same prompt returned `thinking 2172 + text 2397` and valid JSON. |
| The same starvation hits competitor discovery | `claude-sonnet-5`, competitor prompt, `max_tokens: 300` → `stop_reason: max_tokens`, `thinking_tokens: 300`, text length **0**. At `max_tokens: 4300` → `thinking_tokens: 0`, clean JSON with 7 Spanish accelerators. |
| Thinking is adaptive, not constant | The same model at `max_tokens: 60` on the short scoring prompt answered `YES` with no thinking block at all. The reserve is a ceiling a call may use, not a cost it always pays. |
| Gemini rejects the current workaround | `gemini-flash-latest`, identical bodies: with `generationConfig.thinkingConfig.thinkingBudget: 0` → `400 INVALID_ARGUMENT`; without it → `200` and a normal answer. The alias now resolves to a Gemini 3.x model. |

Two facts that shape the design:

- **`CostGuard.settle` releases the hold** (`costs.ts`: `this.reserved[phase] = Math.max(0, this.reserved[phase] - reservedUsd)`). A larger reservation is therefore transient: it is returned as soon as the call settles at its real cost. This is why Task 2 prices the projection on the full cap rather than inventing a second "expected cost" knob.
- **The MCP surface is already honest.** `src/mcp/tools.ts:312` joins `result.notes` into its abort message. Only the CLI drops them, so Task 7 is CLI-only.

---

## File Structure

| File | Change | Responsibility after the change |
| --- | --- | --- |
| `src/core/costs.ts` | Modify | Adds `REASONING_RESERVE_TOKENS` + `judgeMaxTokens()`, the single place judge output caps are sized |
| `src/core/costs.test.ts` | Modify | Guards the reserve against being shrunk below measured thinking spend |
| `src/core/queries/generate.ts` | Modify (`:406`, `:419-433`) | Sizes its cap via the helper; reports an empty/unusable judge response as `skipped` |
| `src/core/queries/generate.test.ts` | Modify | Failure-mode tests for empty and unusable judge text |
| `src/core/discovery/competitors.ts` | Modify (`:235`, `:243-249`) | Same two changes for competitor discovery |
| `src/core/discovery/competitors.test.ts` | Modify | Same two failure-mode tests |
| `src/core/scoring/judge.ts` | Modify (`:101`) | Cap via the helper |
| `src/core/shopping/judge.ts` | Modify (`:152`) | Cap via the helper |
| `src/core/shopping/queries.ts` | Modify (`:244-248`) | Cap via the helper |
| `src/core/engines/gemini.ts` | Modify (`:110-124`) | Stops sending `thinkingBudget: 0`; caps output only |
| `src/core/engines/adapters.test.ts` | Modify (`:349-370`) | The inverted assertion: no `thinkingConfig` is ever sent |
| `src/core/run/check.ts` | Modify (`ProgressEvent`, `RunCheckResult`, `:200-234`) | Aborts before the confirm gate when there are no prompts; tags every abort with a reason |
| `src/core/run/discover-queries.ts` | Modify (`:97-100`) | Carries the query-gen skip reason on the progress event |
| `src/core/run/check.test.ts` | Modify | Covers the zero-prompt abort and its reason |
| `src/cli/progress.ts` | Modify (`:70-74`) | Renders zero prompts as a failure line, not a checkmark |
| `src/cli/progress.test.ts` | Modify | Covers the failure line |
| `src/cli/check.ts` | Modify (`:295-312`) | Prints notes on the abort path; exits non-zero when the abort was not the user's choice |
| `src/cli/cli.test.ts` | Modify | Covers both abort exit codes |

Out of scope, deliberately, with reasons:

- **`gpt-5.3-chat-latest` returning 404 "has been deprecated"** (the OpenAI *ask* default). Real and separately verified, but it is a model-refresh decision with a pricing row to re-verify, not a honesty bug. It deserves its own change.
- **Empty-verdict handling in `scoring/judge.ts` and `shopping/judge.ts`.** Both already leave the row as pass 1 decided and continue. With Task 4's reserve the starvation cause is gone; changing verdict semantics too would widen the blast radius of a bugfix.

---

### Task 1: The shared judge token budget

**Files:**
- Modify: `src/core/costs.ts`
- Test: `src/core/costs.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/costs.test.ts`. Extend the existing import from `./costs.js` with `judgeMaxTokens` and `REASONING_RESERVE_TOKENS`.

```ts
describe('judgeMaxTokens', () => {
  it('adds the reasoning reserve on top of the answer budget', () => {
    expect(judgeMaxTokens(60)).toBe(60 + REASONING_RESERVE_TOKENS);
    expect(judgeMaxTokens(1440)).toBe(1440 + REASONING_RESERVE_TOKENS);
  });

  // A reserve smaller than the largest thinking spend we have MEASURED puts the
  // silent-empty-response bug straight back: claude-sonnet-5 spent 2172 thinking
  // tokens before its first answer token on the M5 generation prompt, and burned
  // all 300 of the competitor call's budget on thinking (verified live
  // 2026-08-13). Shrinking this constant must fail here, not in production.
  it('reserves at least the largest thinking spend measured live', () => {
    expect(REASONING_RESERVE_TOKENS).toBeGreaterThanOrEqual(2172);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- costs`
Expected: FAIL. TypeScript/vitest reports `judgeMaxTokens` and `REASONING_RESERVE_TOKENS` are not exported from `./costs.js`.

- [ ] **Step 3: Implement the helper**

Add to `src/core/costs.ts`, directly below the `MODEL_PRICING` block so it sits with the other budget primitives:

```ts
/**
 * Output tokens reserved for a reasoning judge's private thinking, on top of
 * whatever the answer itself needs.
 *
 * Reasoning models bill thinking as output and draw it from the SAME cap as the
 * answer, so a cap sized for the answer alone starves it. The call still returns
 * HTTP 200 - with an empty text block - and every parser downstream reads that
 * as "the judge found nothing", which is how a failed call became an empty
 * result with no error (rule #6).
 *
 * Measured live 2026-08-13 against claude-sonnet-5: the competitor prompt at
 * max_tokens 300 spent all 300 on thinking and returned zero text; the query
 * generation prompt did the same at 1440. Both answered cleanly with the reserve
 * added (2172 thinking + 2397 text on the generation prompt).
 *
 * Thinking is ADAPTIVE - the same model answered a short scoring prompt at 60
 * tokens with no thinking at all - so this is a ceiling a call is allowed to
 * use, never a cost it always pays. Real spend is settled from reported usage.
 */
export const REASONING_RESERVE_TOKENS = 4000;

/**
 * The output cap for a judge call that needs `answerTokens` for its answer.
 *
 * Every judge call site sizes its cap through this and never with a bare number:
 * a raw answer-sized cap is silently empty on a reasoning judge, and each site
 * that hard-coded one had to be found by hand after it had already shipped.
 */
export function judgeMaxTokens(answerTokens: number): number {
  return answerTokens + REASONING_RESERVE_TOKENS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- costs`
Expected: PASS, including the whole existing `costs` suite.

- [ ] **Step 5: Commit**

```bash
git add src/core/costs.ts src/core/costs.test.ts
git commit -m "Add a shared judge token budget with reasoning headroom"
```

---

### Task 2: Query generation reports an empty or unusable judge response

**Files:**
- Modify: `src/core/queries/generate.ts:400-441`
- Test: `src/core/queries/generate.test.ts`

Note on cost: the projection at `generate.ts:407-409` prices the full cap, so it rises with the reserve. That is deliberate and correct - the tokens really can be spent, and `CostGuard.settle` hands the unused reservation straight back. Do not add a second "expected cost" number.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/queries/generate.test.ts`, inside the existing `describe('generateQueries', ...)`. That block already defines a `profile(overrides?)` factory and a `goodAnswer` JSON string, and the file's `recordingJudge` already captures `maxTokens`, so no helper changes are needed. Extend the import from `../costs.js` with `REASONING_RESERVE_TOKENS`.

```ts
  // The exact production failure of 2026-08-13: claude-sonnet-5 spent the whole
  // 1440-token budget on thinking and returned HTTP 200 with an empty text
  // block. An empty pack with no reason reads as "this brand has no buyer
  // questions" - the run then offered to query 4 engines with 0 prompts.
  it('reports an empty judge response instead of a silently empty pack', async () => {
    const judge = recordingJudge('');
    const guard = new CostGuard();

    const result = await generateQueries(
      profile(),
      { judge, guard },
      { generatedAt: AT_ISO },
    );

    expect(result.pack.queries).toHaveLength(0);
    expect(result.skipped).toMatch(/empty response/i);
  });

  // A response that arrives but parses to nothing (truncated mid-JSON, or a
  // refusal) is the same failure wearing a different hat, and it also used to
  // return a clean empty pack.
  it('reports a response that yielded no usable prompts', async () => {
    const judge = recordingJudge('I am sorry, I cannot help with that.');
    const guard = new CostGuard();

    const result = await generateQueries(
      profile(),
      { judge, guard },
      { generatedAt: AT_ISO },
    );

    expect(result.pack.queries).toHaveLength(0);
    expect(result.skipped).toMatch(/no usable buyer prompts/i);
  });

  it('reserves reasoning headroom in the judge token budget', async () => {
    const judge = recordingJudge(goodAnswer);
    const guard = new CostGuard();

    await generateQueries(profile(), { judge, guard }, { generatedAt: AT_ISO });

    expect(judge.maxTokens[0]).toBeGreaterThanOrEqual(REASONING_RESERVE_TOKENS);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- queries/generate`
Expected: FAIL on all three. The first two report `result.skipped` is `undefined` (this is the silent path). The third reports `judge.maxTokens[0]` is `1440`.

- [ ] **Step 3: Implement**

In `src/core/queries/generate.ts`, add `judgeMaxTokens` to the existing import from `../costs.js`:

```ts
import {
  CostGuard,
  approxTokens,
  estimateCallUsd,
  judgeMaxTokens,
} from '../costs.js';
```

Replace lines 400-406 (the comment block above `maxTokens` and the assignment itself) with:

```ts
  const prompt = buildGenPrompt(profile, intents, counts, year);
  // Scale the ANSWER budget with how many questions we ask (weighting + the +1
  // buffer + paired variants all inflate it), plus headroom for JSON structure
  // and verbose (non-English) phrasing. A fixed budget truncated a large pack
  // mid-JSON, which parses to an EMPTY pack; ~60 tokens/question keeps room.
  // judgeMaxTokens then adds the reasoning reserve on top: a thinking judge
  // draws private reasoning from this same cap and returned zero answer tokens
  // without it (see REASONING_RESERVE_TOKENS).
  const requested = intents.reduce((sum, i) => sum + counts[i], 0);
  const maxTokens = judgeMaxTokens(Math.max(900, requested * 60));
```

Then replace the `try` block body at lines 419-433 with:

```ts
    const res = await judge.complete(prompt, { maxTokens });
    // settle, not record: `authorize` reserved `projected` (see CostGuard).
    guard.settle(projected, res.costUsd, 'setup');
    settled = true;
    // A 200 with no text is a FAILED call, not a brand with no buyer questions.
    // Reported separately from the parse failure below because the fixes differ:
    // an empty body points at the token budget or the model, an unusable one at
    // the response shape.
    if (res.text.trim() === '') {
      return {
        pack: emptyPack,
        skipped: 'the judge returned an empty response',
      };
    }
    const byIntent = parseIntentQueries(res.text, intents);
    const pack = buildQueryPack({
      domain: profile.domain,
      byIntent,
      intents,
      competitors: profile.competitors,
      target,
      axis: axisFor(profile),
      generatedAt: opts.generatedAt,
    });
    if (pack.queries.length === 0) {
      return {
        pack,
        skipped: 'the judge response contained no usable buyer prompts',
      };
    }
    return { pack };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- queries`
Expected: PASS, including `resolve` and `golden`. `resolve.ts` already forwards `skipped` as its `note` and already refuses to persist an empty pack, so no change is needed there.

- [ ] **Step 5: Commit**

```bash
git add src/core/queries/generate.ts src/core/queries/generate.test.ts
git commit -m "Report an empty or unusable query-generation response"
```

---

### Task 3: Competitor discovery reports an empty judge response

**Files:**
- Modify: `src/core/discovery/competitors.ts:235`, `:243-249`
- Test: `src/core/discovery/competitors.test.ts`

- [ ] **Step 1: Write the failing tests**

First extend the file's `recordingJudge` to capture token budgets, matching the M5 helper:

```ts
/** A judge that records the prompt (and token budget) it saw and returns a canned answer. */
function recordingJudge(
  text: string,
  costUsd = 0.001,
  model = 'gpt-4o-mini',
): JudgeClient & { prompts: string[]; maxTokens: (number | undefined)[] } {
  const prompts: string[] = [];
  const maxTokens: (number | undefined)[] = [];
  return {
    prompts,
    maxTokens,
    model,
    async complete(prompt, opts) {
      prompts.push(prompt);
      maxTokens.push(opts?.maxTokens);
      return { text, costUsd, model };
    },
  };
}
```

Then add to `describe('discoverCompetitors', ...)`, importing `REASONING_RESERVE_TOKENS` from `../costs.js`:

```ts
  // Verified live 2026-08-13: claude-sonnet-5 spent all 300 tokens of this
  // call's budget on thinking and returned an empty text block. An empty list
  // with no reason is a claim - "this brand has no rivals" - that the run never
  // actually measured (rule #6).
  it('reports an empty judge response instead of an empty competitor list', async () => {
    const judge = recordingJudge('');
    const guard = new CostGuard();

    const result = await discoverCompetitors(
      { brand: 'Acme Rockets', category: 'Model rockets' },
      { judge, guard },
    );

    expect(result.competitors).toEqual([]);
    expect(result.skipped).toMatch(/empty response/i);
  });

  it('reserves reasoning headroom in the judge token budget', async () => {
    const judge = recordingJudge('["Estes"]');
    const guard = new CostGuard();

    await discoverCompetitors(
      { brand: 'Acme Rockets', category: 'Model rockets' },
      { judge, guard },
    );

    expect(judge.maxTokens[0]).toBeGreaterThanOrEqual(REASONING_RESERVE_TOKENS);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- discovery/competitors`
Expected: FAIL. The first reports `result.skipped` is `undefined`; the second reports `judge.maxTokens[0]` is `300`.

- [ ] **Step 3: Implement**

Add `judgeMaxTokens` to the existing `../costs.js` import in `src/core/discovery/competitors.ts`, then replace line 235:

```ts
  // The answer is a short JSON object; judgeMaxTokens adds the reasoning
  // reserve, without which a thinking judge spent this entire budget on private
  // reasoning and returned nothing (verified live 2026-08-13).
  const maxTokens = judgeMaxTokens(300);
```

And replace the `try` body at lines 243-249:

```ts
  try {
    const res = await judge.complete(prompt, { maxTokens });
    // settle, not record: `authorize` reserved `projected`, and only settling
    // releases that hold (a leaked reservation shrinks the remaining budget).
    guard.settle(projected, res.costUsd, 'setup');
    // A 200 with no text is a failed call. Parsing it yields [], which the
    // profile would then carry as a measured "no competitors".
    if (res.text.trim() === '') {
      return {
        competitors: [],
        skipped: 'the judge returned an empty response',
      };
    }
    const selfTerms = [input.brand, ...(input.aliases ?? [])];
    return parseDiscovery(res.text, selfTerms);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- discovery`
Expected: PASS across the discovery suite, including `discover` and `profile`.

- [ ] **Step 5: Commit**

```bash
git add src/core/discovery/competitors.ts src/core/discovery/competitors.test.ts
git commit -m "Report an empty competitor-discovery response"
```

---

### Task 4: Route the remaining judge call sites through the helper

**Files:**
- Modify: `src/core/scoring/judge.ts:101`
- Modify: `src/core/shopping/judge.ts:152`
- Modify: `src/core/shopping/queries.ts:244-248`
- Test: `src/core/scoring/judge.test.ts`

These three are mechanical. The scoring loop's 60-token cap is the most exposed number in the codebase: it is the one that made the Gemini adapter need `thinkingBudget: 0` in the first place, and Task 5 cannot land safely until it is fixed.

- [ ] **Step 1: Write the failing test**

Add to `src/core/scoring/judge.test.ts`. The existing `countingJudge` does not capture options, so add a local recorder next to it:

```ts
/** A judge that records the token budget it was given. */
function budgetJudge(text: string): JudgeClient & { maxTokens: (number | undefined)[] } {
  const maxTokens: (number | undefined)[] = [];
  return {
    maxTokens,
    model: 'gpt-4o-mini',
    async complete(_prompt, opts) {
      maxTokens.push(opts?.maxTokens);
      return { text, costUsd: 0.001, model: 'gpt-4o-mini' };
    },
  };
}
```

Then, inside the existing `describe('refineAmbiguous', ...)`. The file already defines the `profile` fixture, `answer(text)` and `ambiguousMention(over?)`. `judgeRateCap: 1` is required: the default `JUDGE_RATE_CAP` is `0.3`, so a single result gives `maxJudge === 0` and the judge is never called. Import `REASONING_RESERVE_TOKENS` from `../costs.js`.

```ts
  // 60 tokens is an ANSWER budget. On a reasoning judge it is also the whole
  // thinking budget, and thinking goes first - the verdict comes back empty and
  // the row silently keeps its pass-1 value (verified live 2026-08-13).
  it('reserves reasoning headroom in the judge token budget', async () => {
    const judge = budgetJudge('YES');
    const guard = new CostGuard();

    await refineAmbiguous(
      [ambiguousMention()],
      [answer('You could try Acme.')],
      profile,
      { judge, guard },
      { judgeRateCap: 1 },
    );

    expect(judge.maxTokens[0]).toBeGreaterThanOrEqual(REASONING_RESERVE_TOKENS);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- scoring/judge`
Expected: FAIL, reporting `judge.maxTokens[0]` is `60`.

- [ ] **Step 3: Implement all three call sites**

`src/core/scoring/judge.ts` - add `judgeMaxTokens` to the `../costs.js` import, then replace line 101:

```ts
  // A verdict is a word; judgeMaxTokens adds the reasoning reserve so a thinking
  // judge is not out of budget before it writes that word.
  const maxTokens = judgeMaxTokens(60);
```

`src/core/shopping/judge.ts` - same import change, then replace line 152:

```ts
  const maxTokens = judgeMaxTokens(200);
```

`src/core/shopping/queries.ts` - same import change, then replace lines 244-248:

```ts
    const maxTokens = judgeMaxTokens(
      Math.max(
        600,
        products.length * (visibilityCount + REPUTATION_PROMPTS_PER_PRODUCT) * 45,
      ),
    );
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. No existing test asserts one of these caps as a literal (checked 2026-08-13); the one budget assertion, `generate.test.ts:461`, is relative (`big > small`) and survives a constant added to both sides. If a literal does surface, assert it through `judgeMaxTokens(...)` rather than hard-coding the new number - a literal there re-creates the drift this task removes.

- [ ] **Step 5: Commit**

```bash
git add src/core/scoring/judge.ts src/core/scoring/judge.test.ts src/core/shopping/judge.ts src/core/shopping/queries.ts
git commit -m "Size the scoring and shopping judge budgets with reasoning headroom"
```

---

### Task 5: Stop sending Gemini an unsupported thinking budget

**Files:**
- Modify: `src/core/engines/gemini.ts:102-126`
- Test: `src/core/engines/adapters.test.ts:349-370`

This must come after Task 4. `thinkingBudget: 0` exists because the 60-token scoring cap starved Gemini's answer; removing it before the caps carry headroom would re-create that bug on a different provider.

- [ ] **Step 1: Rewrite the existing test as the inverted assertion**

Replace the whole `it('disables Gemini thinking when the caller caps tokens', ...)` block at `src/core/engines/adapters.test.ts:349-370`, comment included:

```ts
  // `thinkingConfig.thinkingBudget: 0` was added on 2026-07-20, when a 60-token
  // scoring cap left Gemini's answer as one stray character. It has since become
  // a hard failure: gemini-flash-latest now resolves to a Gemini 3.x model that
  // rejects the field outright. Verified live 2026-08-13 with two otherwise
  // identical bodies - with the field, HTTP 400 INVALID_ARGUMENT; without it,
  // HTTP 200 and a normal answer. Every judge cap now carries
  // REASONING_RESERVE_TOKENS of headroom, so thinking has room and does not need
  // disabling.
  it('caps Gemini output without sending a thinking budget', async () => {
    const { fn, calls } = fakePost(geminiReal);
    const adapter = createAdapter(geminiSpec, { httpPost: fn, apiKey: 'k' });

    await adapter.ask('judge this', { maxTokens: 4060 });
    const capped = JSON.parse(calls[0]!.body) as {
      generationConfig?: { maxOutputTokens?: number; thinkingConfig?: unknown };
    };
    expect(capped.generationConfig?.maxOutputTokens).toBe(4060);
    expect(capped.generationConfig?.thinkingConfig).toBeUndefined();

    await adapter.ask('answer this');
    const uncapped = JSON.parse(calls[1]!.body) as {
      generationConfig?: unknown;
    };
    expect(uncapped.generationConfig).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- engines/adapters`
Expected: FAIL on `expect(capped.generationConfig?.thinkingConfig).toBeUndefined()`, which receives `{ thinkingBudget: 0 }`.

- [ ] **Step 3: Implement**

Replace `src/core/engines/gemini.ts:102-126` (the whole `buildRequest`):

```ts
  buildRequest: ({ prompt, mode, apiKey, maxTokens }) => ({
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      ...(mode === 'grounded' ? { tools: [{ google_search: {} }] } : {}),
      // Gemini budgets thinking and answer from the SAME maxOutputTokens pool,
      // so a caller-supplied cap must leave room for both. That is now handled
      // upstream: every judge cap is sized by judgeMaxTokens, which adds
      // REASONING_RESERVE_TOKENS. Do NOT reintroduce thinkingConfig here - the
      // Gemini 3.x models this alias resolves to reject thinkingBudget: 0 with
      // HTTP 400 INVALID_ARGUMENT, which broke every capped Gemini judge call
      // (verified live 2026-08-13). The ask path passes no cap at all and keeps
      // thinking on: that is what a real Gemini user gets, and it is the answer
      // we are measuring.
      ...(maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}),
    },
  }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- engines`
Expected: PASS. `review-fixes.test.ts:133` ("maps maxTokens to generationConfig.maxOutputTokens") must still pass unchanged - it asserts only `maxOutputTokens`.

- [ ] **Step 5: Verify against the live API**

The unit tests cannot catch this class of bug - the old code passed its tests for three weeks while returning HTTP 400 in production. Confirm with the real endpoint:

```bash
export $(grep GOOGLE_API_KEY .env)
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" \
  -H "x-goog-api-key: $GOOGLE_API_KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"say ok"}]}],"generationConfig":{"maxOutputTokens":4060}}' | head -c 200
```

Expected: a `"candidates"` array containing a text part. A `"error"` object with `code: 400` means the body is still wrong.

- [ ] **Step 6: Commit**

```bash
git add src/core/engines/gemini.ts src/core/engines/adapters.test.ts
git commit -m "Stop sending Gemini a thinking budget its models reject"
```

---

### Task 6: A run with no prompts aborts before the cost gate

**Files:**
- Modify: `src/core/run/check.ts` (`ProgressEvent`, `RunCheckResult`, the confirm gate at `:200-234`)
- Modify: `src/core/run/discover-queries.ts:97-100`
- Test: `src/core/run/check.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/run/check.test.ts`, in the same `describe` as the existing abort tests. The file already has `STATE`, `CACHED_PROFILE`, `memFs`, `baseDeps`, `fakeFetch` and `profilePath`.

Note the fs: `seededFs()` seeds a cached *query pack*, which would short-circuit generation. These tests seed only the profile, so `resolveQueries` reaches the judge.

Add one helper next to `fakeJudge`:

```ts
/** A judge whose call fails, the way an out-of-credit provider does. */
function throwingJudge(message: string): JudgeClient {
  return {
    model: 'judge-model',
    complete: async () => {
      throw new Error(message);
    },
  };
}
```

Then the tests:

```ts
  // The 2026-08-13 report: a judge failure left 0 prompts, and the run went on
  // to offer "query 4 engines with 0 prompts (estimated cost: an unknown
  // amount)". A run with nothing to ask cannot measure anything, so it must stop
  // before the gate and say why.
  it('aborts before the confirmation gate when no prompts were generated', async () => {
    const fs = memFs({ [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE) });
    let confirmCalls = 0;

    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        judge: throwingJudge('HTTP 429: no credits remaining'),
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
      { stateDir: STATE },
    );

    expect(confirmCalls).toBe(0);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('no-prompts');
    expect(result.envelope).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/no buyer prompts/i);
  });

  // The reason the judge failed must survive to the caller: it is the only thing
  // that tells a user whether to add credits, switch judge, or file a bug.
  it('keeps the query-generation failure reason in the notes', async () => {
    const fs = memFs({ [profilePath(STATE)]: JSON.stringify(CACHED_PROFILE) });

    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        judge: throwingJudge('HTTP 429: no credits remaining'),
      },
      { stateDir: STATE, yes: true },
    );

    expect(result.notes.join(' ')).toMatch(/429/);
  });

  // A user who declines is not a failure, and must not be reported as one.
  it('tags a declined run separately from a failed one', async () => {
    const fs = seededFs();

    const result = await runCheck(
      'acme.example',
      {
        ...baseDeps(fs, createFetcher({ fetchImpl: fakeFetch() })),
        confirm: async () => false,
      },
      { stateDir: STATE },
    );

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('declined');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- run/check`
Expected: FAIL. The first reports `confirmCalls` is `1` (the gate was reached with zero prompts); `abortReason` is `undefined` in the first and third.

- [ ] **Step 3: Implement**

In `src/core/run/check.ts`, add `note` to the `queries-done` event:

```ts
export type ProgressEvent =
  | { kind: 'discovery-start' }
  | { kind: 'discovery-done'; brand: string }
  | { kind: 'queries-start' }
  /** `note` carries why generation produced nothing, when it did. */
  | { kind: 'queries-done'; prompts: string[]; note?: string }
  | { kind: 'ask-start'; total: number }
  | { kind: 'ask-answered'; done: number; total: number }
  | { kind: 'ask-done'; answered: number; total: number }
  | { kind: 'scoring-start' }
  | { kind: 'scoring-done' };
```

Add `abortReason` to `RunCheckResult`, below `aborted`:

```ts
  /** True when the run stopped before querying any engine. */
  aborted: boolean;
  /**
   * Why the run aborted. `declined` is the user's own choice and is not a
   * failure; the other two are, and a caller that maps aborts to an exit code
   * must be able to tell them apart.
   */
  abortReason?: 'declined' | 'no-prompts' | 'unconfirmed';
```

In `src/core/run/discover-queries.ts`, replace lines 97-100:

```ts
  report({
    kind: 'queries-done',
    prompts: queries.pack.queries.map((q) => q.prompt),
    ...(queries.note ? { note: queries.note } : {}),
  });
```

In `src/core/run/check.ts`, insert the guard immediately after `brandedPrompts` is computed (currently line 205) and before the confirm-gate comment:

```ts
  // Nothing to ask means nothing to measure. Stopping HERE, before the gate,
  // matters twice over: the gate would otherwise quote "0 prompts" against an
  // unpriceable estimate, and every engine call after it would be spend with no
  // possible result. The note carries the reason generation failed (rule #6).
  if (prompts.length === 0) {
    notes.push(
      'No buyer prompts were generated, so no engines were queried. Nothing was measured.',
    );
    return {
      aborted: true,
      abortReason: 'no-prompts',
      notes,
      spend: guard.spendBreakdown,
    };
  }
```

Then tag the two existing abort paths. At the missing-confirm-handler return:

```ts
      return {
        aborted: true,
        abortReason: 'unconfirmed',
        notes,
        spend: guard.spendBreakdown,
      };
```

And at the declined return:

```ts
      return {
        aborted: true,
        abortReason: 'declined',
        notes,
        spend: guard.spendBreakdown,
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- run`
Expected: PASS across the run suite.

- [ ] **Step 5: Commit**

```bash
git add src/core/run/check.ts src/core/run/discover-queries.ts src/core/run/check.test.ts
git commit -m "Abort a check with no buyer prompts before the cost gate"
```

---

### Task 7: The CLI shows the failure instead of a checkmark

**Files:**
- Modify: `src/cli/progress.ts:70-74`
- Modify: `src/cli/check.ts:295-312`
- Test: `src/cli/progress.test.ts`, `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/progress.test.ts`:

```ts
  // `✓ Generated 0 buyer prompts` is a success mark on a total failure. It is
  // what the 2026-08-13 report saw, and it is why the real error (an
  // out-of-credit judge) never reached the user.
  it('marks zero prompts as a failure, not a checkmark', () => {
    const out = drive([
      { kind: 'discovery-start' },
      { kind: 'discovery-done', brand: 'Acme' },
      { kind: 'queries-start' },
      {
        kind: 'queries-done',
        prompts: [],
        note: 'judge error: HTTP 429: no credits remaining',
      },
    ]);

    expect(out).not.toContain('✓ Generated');
    expect(out).toContain('No buyer prompts were generated');
    expect(out).toContain('HTTP 429');
  });

  it('still marks a normal pack with a checkmark', () => {
    const out = drive(FULL_RUN);
    expect(out).toContain('✓ Generated 2 buyer prompts');
  });
```

Add to `src/cli/cli.test.ts`, alongside the existing abort coverage. These drive the real command through the file's `testRuntime` + `run` helpers rather than stubbing a result.

`--regenerate` is what makes this work end to end: `testRuntime` seeds a cached `PACK`, and `--regenerate` bypasses it so generation actually runs. The module-level `judge` fixture returns `'{}'`, which parses to zero prompts for every intent - exactly the "response contained no usable buyer prompts" path from Task 2. The suite's existing `afterEach` resets `process.exitCode` to `0`, so the declined case asserts `0`, not `undefined`.

```ts
  // An aborted run already carried its reason in result.notes; the CLI printed
  // notes only on the success path, so the one user who most needed them - the
  // one whose run produced nothing - was the only one who never saw them.
  it('prints why a check aborted with no prompts, and exits non-zero', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });

    await run(rt, ['check', 'acme.example', '--yes', '--regenerate']);

    const all = rt.output.join('') + rt.errors.join('');
    expect(all).toContain('Aborted');
    expect(all).toContain('No buyer prompts were generated');
    expect(all).toContain('no usable buyer prompts');
    // Nothing was measured. CI and AI agents read the exit code.
    expect(process.exitCode).toBe(1);
  });

  // Declining the spend is the gate working as designed. Exiting non-zero for it
  // would tell CI that a deliberate choice was a failure.
  it('exits zero when the user declines the spend', async () => {
    const rt = testRuntime({ env: { OPENAI_API_KEY: 'sk-test' } });
    const base = rt.checkDeps!;
    rt.checkDeps = (...args: Parameters<typeof base>) => ({
      ...base(...args),
      confirm: async () => false,
    });

    await run(rt, ['check', 'acme.example']);

    expect(rt.output.join('') + rt.errors.join('')).toContain('Aborted');
    expect(process.exitCode).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- cli`
Expected: FAIL. The progress test finds `✓ Generated 0 buyer prompts` where it expected the failure line. The first CLI test fails on `expect(process.exitCode).toBe(1)` (it is `0`) and on the missing note text. The declined test passes already - it is a regression guard for the exit-code change, not a new behavior.

- [ ] **Step 3: Implement the progress change**

Replace the `queries-done` case in `src/cli/progress.ts` (lines 70-74):

```ts
      case 'queries-done': {
        // Zero prompts is never a success. The checkmark here reported a failed
        // judge call as a completed phase, and the run then walked on to the
        // cost gate quoting 0 prompts.
        if (event.prompts.length === 0) {
          commit(
            `! No buyer prompts were generated${event.note ? `: ${event.note}` : ''}`,
          );
          return;
        }
        commit(`✓ Generated ${plural(event.prompts.length, 'buyer prompt')}`);
        event.prompts.forEach((p, i) => deps.write(`  ${i + 1}. ${p}\n`));
        return;
      }
```

- [ ] **Step 4: Implement the CLI abort change**

In `src/cli/check.ts`, replace the abort block (lines 295-312):

```ts
      if (result.aborted) {
        // Under --json, stdout is the envelope channel and nothing else may
        // touch it: an agent that gets prose here cannot tell an abort from a
        // crash. Every other branch already routes prose to stderr; this one
        // did not, and the spend line made it a second offender.
        const say = (s: string): void => {
          if (flags.json) rt.err(s);
          else rt.out(s);
        };
        say('Aborted - no engines were queried.\n');
        // The notes carry WHY - an out-of-credit judge, a setup cost cap, a
        // failed generation. They used to print only on the success path, so an
        // aborted run was silent about its own cause.
        for (const note of result.notes) say(`${note}\n`);
        // Discovery and query generation bill BEFORE the confirmation gate, so
        // an aborted run is not necessarily a free one. Reported only when it
        // actually cost something, so a genuinely free abort stays quiet.
        const spent = result.spend;
        if (spent && spent.totalUsd > 0) {
          say(`${spendLine(spent)}\n`);
        }
        // Declining is the user's choice and exits 0. An abort the user did not
        // choose measured nothing, and CI and AI agents read the exit code.
        if (result.abortReason && result.abortReason !== 'declined') {
          process.exitCode = 1;
        }
        return;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- cli`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/progress.ts src/cli/progress.test.ts src/cli/check.ts src/cli/cli.test.ts
git commit -m "Show why a check aborted instead of a checkmark over nothing"
```

---

### Task 8: Full gate and a real end-to-end run

**Files:** none (verification only)

- [ ] **Step 1: Run the full pre-commit gate**

```bash
npm run check
npm run format:check
npm run build
```

Expected: all green, `dist/` emitted. Do not pipe any of these through `| tail` - the pipe masks the exit code.

- [ ] **Step 2: Reproduce the original report against the real thing**

The bug was invisible to a green test suite, so the fix has to be confirmed against a live judge. `sonar` is the judge verified working on this machine on 2026-08-13.

```bash
rm -rf ~/.optifeed/bcombinator.com
npm run dev -- check bcombinator.com --judge sonar --quick --yes --max-cost 0.50
```

Expected: `✓ Generated 8 buyer prompts` followed by the numbered list, then the ask and score phases. The prompts are in Spanish - the discovered profile's locale is `es-ES`.

- [ ] **Step 3: Reproduce the FAILURE path against the real thing**

This is the case the whole plan exists for. The OpenAI key on this machine has no credits, which makes it a live fixture for a failing judge:

```bash
rm -rf ~/.optifeed/bcombinator.com
npm run dev -- check bcombinator.com --judge gpt-5.4 --yes
echo "exit code: $?"
```

Expected: a `! No buyer prompts were generated: judge error: HTTP 429 ...` line naming `credit_balance_exhausted`, then `Aborted - no engines were queried.` with the note repeated, and `exit code: 1`. No cost-confirmation line, and no offer to query engines with 0 prompts.

- [ ] **Step 4: Confirm the Gemini judge works end to end**

Task 5's fix is the one no unit test can prove. The Google key on this machine is valid (its models list returns 200), so a Gemini judge run exercises the real request body:

```bash
rm -rf ~/.optifeed/bcombinator.com
npm run dev -- check bcombinator.com --judge gemini-flash-latest --quick --yes --max-cost 0.50
```

Expected: prompts generated, no `HTTP 400 INVALID_ARGUMENT` anywhere in the output.

- [ ] **Step 5: Commit anything the gate changed**

```bash
git status --short
```

Expected: clean. If `format:check` rewrote anything, commit it:

```bash
git add -A
git commit -m "Apply formatter after the judge honesty fixes"
```

---

## Module report (for the PR description)

The PR description ends with a `## Module report` covering:

- **Built:** a shared `judgeMaxTokens` budget with reasoning headroom (`core/costs`); empty/unusable judge responses reported as skip reasons in `core/queries` and `core/discovery`; the Gemini `thinkingBudget: 0` workaround removed; a zero-prompt run aborting before the cost gate with a typed `abortReason`; the CLI printing abort notes and exiting non-zero on an abort the user did not choose.
- **Deviations:** none expected. If the reserve of 4000 tokens proves insufficient for a provider, raise `REASONING_RESERVE_TOKENS` and cite the measurement - do not add a per-provider special case.
- **What the next module needs:** `RunCheckResult.abortReason` is new and optional; the MCP surface at `src/mcp/tools.ts:312` already prints `result.notes` on abort and needs no change, but a future MCP change should map `abortReason` the way the CLI does. The OpenAI ask default `gpt-5.3-chat-latest` returns HTTP 404 "has been deprecated" as of 2026-08-13 and needs its own change, with its `MODEL_PRICING` row re-verified.
