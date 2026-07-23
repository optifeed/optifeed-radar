# Retailer Seller-Axis Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. (Subagent-driven execution is NOT used in this repo by owner
> instruction.)

**Goal:** A retailer's `check` measures where-to-buy visibility against rival
shops, instead of scoring 0 against manufacturers it does not compete with.

**Architecture:** The single existing discovery judge call also classifies the
brand (`businessType: retailer | maker | service`), which is persisted on
`BrandProfile` like any other sourced field. M5 keys two table-driven
differences off it: a new `where-to-buy` intent (gated exactly as `local` is
gated on `geo`) and per-type intent guidance. Everything unknown falls back to
today's maker behavior. Scoring math, `SCORING_VERSION` and `schema_version`
are untouched.

**Tech Stack:** TypeScript strict / ESM, vitest, existing `core/discovery` and
`core/queries` modules. No new dependencies.

**Spec:** `/Users/erdem/workspace/optifeed-radar-docs/dev-plan.md`, section
"M5a - Seller-axis prompts for retailers".

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/core/types.ts` | shared types | add `BusinessType`, `BrandProfile.businessType`, extend `ProfileField`, add `'where-to-buy'` to `QueryIntent` |
| `src/core/discovery/competitors.ts` | the one discovery judge call | parse `{businessType, competitors}`, keep bare-array fallback, ask for rivals of the right kind |
| `src/core/discovery/profile.ts` | profile assembly + merge | carry `businessType` through `buildProfile`/`mergeProfile` |
| `src/core/discovery/persist.ts` | profile load validation | vouch for `businessType` when present |
| `src/core/discovery/discover.ts` | discovery orchestration | pass the classified type into the profile |
| `src/core/queries/generate.ts` | pack shape + generation prompt | per-type weights/guidance, gate `where-to-buy`, facts line |
| `METHODOLOGY.md` | published methodology | document the two pack shapes |
| `TASKS.md` | status | record the live verification |

---

### Task 1: Carry `businessType` on the profile (no behavior change yet)

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/discovery/profile.ts`
- Modify: `src/core/discovery/persist.ts`
- Test: `src/core/discovery/profile.test.ts`, `src/core/discovery/persist.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/core/discovery/profile.test.ts`:

```ts
it('carries the discovered businessType and marks it llm-sourced', () => {
  const profile = buildProfile({
    domain: 'shop.example',
    signals: {
      brand: 'Shop',
      aliases: [],
      sources: { brand: 'extracted', aliases: 'extracted' },
    },
    competitors: ['Rival Shop'],
    businessType: 'retailer',
    generatedAt: '2026-07-23T00:00:00.000Z',
  });

  expect(profile.businessType).toBe('retailer');
  expect(profile.sources?.businessType).toBe('llm');
});

it('preserves a user-edited businessType across --refresh', () => {
  const existing: BrandProfile = {
    schema_version: SCHEMA_VERSION,
    domain: 'shop.example',
    brand: 'Shop',
    aliases: [],
    competitors: [],
    businessType: 'retailer',
    sources: { businessType: 'user' },
  };
  const fresh: BrandProfile = {
    ...existing,
    businessType: 'maker',
    sources: { businessType: 'llm' },
  };

  const merged = mergeProfile(existing, fresh);

  expect(merged.businessType).toBe('retailer');
  expect(merged.sources?.businessType).toBe('user');
});
```

In `src/core/discovery/persist.test.ts`:

```ts
it('rejects a hand-edited businessType that is not a known value', async () => {
  const bad = JSON.stringify({
    schema_version: SCHEMA_VERSION,
    domain: 'shop.example',
    brand: 'Shop',
    aliases: [],
    competitors: [],
    businessType: 'wholesaler',
  });
  const fs = memFs({ [profilePath('/state')]: bad });

  await expect(loadProfile('/state', fs.fs)).rejects.toThrow(ProfileParseError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/discovery/profile.test.ts src/core/discovery/persist.test.ts`
Expected: FAIL - `businessType` not accepted by `BuildProfileInput` (type error),
`merged.businessType` undefined, and `loadProfile` resolves instead of rejecting.

- [ ] **Step 3: Implement**

In `src/core/types.ts`, add the type and extend two existing declarations:

```ts
/**
 * What kind of business this is, which decides the prompt axis (M5a).
 * A `retailer` sells other makers' products, so buyers ask WHERE to buy;
 * a `maker` sells its own, so buyers ask WHAT to buy. `service` and any
 * unknown value take the maker path.
 */
export type BusinessType = 'retailer' | 'maker' | 'service';
```

```ts
export type ProfileField =
  | 'brand'
  | 'aliases'
  | 'category'
  | 'offerings'
  | 'locale'
  | 'competitors'
  | 'businessType';
```

and on `BrandProfile`, directly after `competitors`:

```ts
  /** Decides the query axis (M5a); absent means the maker path. */
  businessType?: BusinessType;
```

In `src/core/discovery/profile.ts`, add `'businessType'` to the end of
`PROFILE_FIELDS`, add the field to `BuildProfileInput`:

```ts
  businessType?: BusinessType;
```

and inside `buildProfile`, after the `competitors` source line:

```ts
  if (input.businessType) sources.businessType = 'llm';
```

and in the returned object, directly after `competitors,`:

```ts
    ...(input.businessType ? { businessType: input.businessType } : {}),
```

In `src/core/discovery/persist.ts`, inside `validateProfile` after
`v.array(obj, 'competitors');`:

```ts
  // Optional, but a consumer (M5 activeIntents) reads it, so vouch for the
  // value when present rather than letting a typo silently pick an axis.
  const businessType = (obj as Record<string, unknown>).businessType;
  if (
    businessType !== undefined &&
    businessType !== 'retailer' &&
    businessType !== 'maker' &&
    businessType !== 'service'
  ) {
    throw new ProfileParseError(
      path,
      new Error('businessType must be retailer, maker or service'),
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/discovery/`
Expected: PASS, no other discovery test regresses.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/discovery/profile.ts src/core/discovery/persist.ts src/core/discovery/profile.test.ts src/core/discovery/persist.test.ts
git commit -m "M5a: carry businessType on the brand profile"
```

---

### Task 2: The discovery call classifies the business

**Files:**

- Modify: `src/core/discovery/competitors.ts`
- Test: `src/core/discovery/competitors.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('parses businessType and competitors from one judge call', async () => {
  const judge = recordingJudge(
    '{"businessType":"retailer","competitors":["Zuhal Müzik","MyDukkan"]}',
  );
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  const result = await discoverCompetitors({ brand: 'doremusic' }, { judge, guard });

  expect(result.businessType).toBe('retailer');
  expect(result.competitors).toEqual(['Zuhal Müzik', 'MyDukkan']);
});

// A judge that ignores the new instruction must degrade, not break: the
// competitor list is the older, more important half of this call.
it('still accepts a bare array, with no businessType', async () => {
  const judge = recordingJudge('["Estes", "Quest"]');
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  const result = await discoverCompetitors({ brand: 'Acme' }, { judge, guard });

  expect(result.competitors).toEqual(['Estes', 'Quest']);
  expect(result.businessType).toBeUndefined();
});

it('ignores an unknown businessType rather than trusting it', async () => {
  const judge = recordingJudge(
    '{"businessType":"wholesaler","competitors":["Estes"]}',
  );
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  const result = await discoverCompetitors({ brand: 'Acme' }, { judge, guard });

  expect(result.businessType).toBeUndefined();
  expect(result.competitors).toEqual(['Estes']);
});

it('asks the judge to classify and to match rivals to that classification', async () => {
  const judge = recordingJudge('{"businessType":"maker","competitors":[]}');
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  await discoverCompetitors({ brand: 'Acme' }, { judge, guard });

  expect(judge.prompts[0]).toContain('businessType');
  expect(judge.prompts[0]).toContain('rival shops');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/discovery/competitors.test.ts`
Expected: FAIL - `result.businessType` is undefined for the object response,
and the prompt contains neither string.

- [ ] **Step 3: Implement**

In `src/core/discovery/competitors.ts`, add to `CompetitorResult`:

```ts
  /** How the judge classified the business (M5a); absent when unknown. */
  businessType?: BusinessType;
```

Add a parser beside `parseCompetitors`:

```ts
/**
 * Parse the discovery call's response. The judge is asked for
 * `{"businessType": ..., "competitors": [...]}`, but a model that ignores that
 * shape and returns a bare array must still yield competitors (lesson #4:
 * parse every real shape, not just the canonical one). An unrecognized
 * businessType is dropped rather than trusted - the maker path is the safe
 * default, exactly like an unranked judge model falling back to price.
 */
export function parseDiscovery(
  text: string,
  selfTerms: string[] = [],
): { businessType?: BusinessType; competitors: string[] } {
  const object = extractBalanced(text.trim(), '{', '}');
  if (object !== null) {
    try {
      const parsed: unknown = JSON.parse(object);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const row = parsed as Record<string, unknown>;
        const raw = row.businessType;
        const businessType =
          raw === 'retailer' || raw === 'maker' || raw === 'service'
            ? raw
            : undefined;
        const list = Array.isArray(row.competitors)
          ? row.competitors.filter((x): x is string => typeof x === 'string')
          : [];
        return {
          ...(businessType ? { businessType } : {}),
          competitors: capped(dropSelfReferences(dedupe(list), selfTerms)),
        };
      }
    } catch {
      // Fall through to the array/list parser.
    }
  }
  return { competitors: parseCompetitors(text, selfTerms) };
}
```

Replace the two closing lines of the `try` block in `discoverCompetitors`:

```ts
    const selfTerms = [input.brand, ...(input.aliases ?? [])];
    return parseDiscovery(res.text, selfTerms);
```

In `buildPrompt`, replace the two closing instruction lines with:

```ts
    'Also classify the business itself, because it decides which rivals are',
    'the right ones: "retailer" sells other makers\' products (a shop or',
    'marketplace), "maker" sells products it makes, "service" sells services.',
    'For a retailer list rival shops a buyer would buy from instead, NEVER the',
    'manufacturers it stocks; for a maker list rival makers.',
    '',
    'Return ONLY a JSON object of the form',
    '{"businessType": "retailer", "competitors": ["Foo", "Bar"]}.',
    'No commentary. Do not include the brand itself, any of the names above,',
    'or a variant spelling or translation of them.',
```

Add `BusinessType` to the type import at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/discovery/`
Expected: PASS. The self-reference tests from the earlier fix must still pass -
they now run through `parseDiscovery`'s array branch.

- [ ] **Step 5: Commit**

```bash
git add src/core/discovery/competitors.ts src/core/discovery/competitors.test.ts
git commit -m "M5a: classify the business in the one discovery call"
```

---

### Task 3: Wire the classification into the profile

**Files:**

- Modify: `src/core/discovery/discover.ts:172-188`
- Test: `src/core/discovery/discover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('persists the businessType the discovery call returned', async () => {
  const { fetcher } = fakeFetcher({
    'https://acme.example/': fixture('schema-rich.html'),
  });
  const j = judge('{"businessType":"retailer","competitors":["Rival Shop"]}');
  const { fs } = memFs();

  const result = await discover(
    'acme.example',
    { fetcher, judge: j, guard: new CostGuard(), fs, now: () => AT },
    { stateDir: '/state' },
  );

  expect(result.profile.businessType).toBe('retailer');
  expect(result.profile.sources?.businessType).toBe('llm');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/discovery/discover.test.ts`
Expected: FAIL - `businessType` is undefined on the built profile.

- [ ] **Step 3: Implement**

In `src/core/discovery/discover.ts`, alongside the existing `competitors` and
`competitorNote` locals:

```ts
  let businessType: BusinessType | undefined;
```

inside the `if (deps.judge)` branch after `competitors = res.competitors;`:

```ts
    businessType = res.businessType;
```

and in the `buildProfile` call:

```ts
    ...(businessType ? { businessType } : {}),
```

Add `BusinessType` to the type import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/discovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/discovery/discover.ts src/core/discovery/discover.test.ts
git commit -m "M5a: persist the classified business type"
```

---

### Task 4: The retailer pack shape

**Files:**

- Modify: `src/core/types.ts` (`QueryIntent`)
- Modify: `src/core/queries/generate.ts`
- Test: `src/core/queries/generate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const retailer: BrandProfile = {
  schema_version: SCHEMA_VERSION,
  domain: 'shop.example',
  brand: 'Shop',
  aliases: [],
  competitors: [],
  businessType: 'retailer',
};

it('gives a retailer where-to-buy and drops the known-zero best-of intent', () => {
  expect(activeIntents(retailer)).toEqual([
    'where-to-buy',
    'comparison',
    'problem',
    'trust',
  ]);
});

it('leaves a maker pack exactly as it was', () => {
  const maker: BrandProfile = { ...retailer, businessType: 'maker' };
  expect(activeIntents(maker)).toEqual([
    'best-of',
    'comparison',
    'problem',
    'trust',
  ]);
});

it('treats an unknown or absent businessType as a maker', () => {
  const unset: BrandProfile = { ...retailer };
  delete unset.businessType;
  expect(activeIntents(unset)).toEqual([
    'best-of',
    'comparison',
    'problem',
    'trust',
  ]);
  expect(activeIntents({ ...retailer, businessType: 'service' })).toEqual([
    'best-of',
    'comparison',
    'problem',
    'trust',
  ]);
});

it('weights where-to-buy heaviest for a retailer', () => {
  const intents = activeIntents({ ...retailer, geo: 'Istanbul' });
  expect(intentQuotas(20, intents, 'retailer')).toEqual({
    'where-to-buy': 8,
    comparison: 3,
    problem: 3,
    trust: 3,
    local: 3,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/queries/generate.test.ts`
Expected: FAIL - `'where-to-buy'` is not a `QueryIntent`, `activeIntents`
ignores `businessType`, and `intentQuotas` takes two arguments.

- [ ] **Step 3: Implement**

In `src/core/types.ts`:

```ts
export type QueryIntent =
  | 'best-of'
  | 'where-to-buy'
  | 'comparison'
  | 'problem'
  | 'trust'
  | 'local';
```

In `src/core/queries/generate.ts`:

```ts
export const QUERY_INTENTS: QueryIntent[] = [
  'best-of',
  'where-to-buy',
  'comparison',
  'problem',
  'trust',
  'local',
];

/**
 * Is this profile on the seller axis? Anything not explicitly a retailer -
 * `maker`, `service`, a hand-edited unknown, or an older profile with no field
 * at all - takes the maker path, which is the behavior that shipped before
 * M5a. A new business type therefore degrades to the old default rather than
 * silently changing someone's prompts.
 */
function isRetailer(profile: BrandProfile): boolean {
  return profile.businessType === 'retailer';
}

/**
 * Relative weight per intent, by axis. `best-of` leads for a maker (the most
 * rewrite-stable form, Profound fanout study); `where-to-buy` leads harder for
 * a retailer because it is the only intent whose answers name shops at all.
 */
export const INTENT_WEIGHTS: Record<'maker' | 'retailer', Record<QueryIntent, number>> = {
  maker: {
    'best-of': 2,
    'where-to-buy': 0,
    comparison: 1,
    problem: 1,
    trust: 1,
    local: 1,
  },
  retailer: {
    'best-of': 0,
    'where-to-buy': 3,
    comparison: 1,
    problem: 1,
    trust: 1,
    local: 1,
  },
};
```

`activeIntents` gates the two axis-specific intents the way `local` is already
gated on `geo`:

```ts
export function activeIntents(profile: BrandProfile): QueryIntent[] {
  const retailer = isRetailer(profile);
  return QUERY_INTENTS.filter((intent) => {
    if (intent === 'local') return Boolean(profile.geo);
    if (intent === 'where-to-buy') return retailer;
    if (intent === 'best-of') return !retailer;
    return true;
  });
}
```

`intentQuotas` takes the axis and reads that row (every other line unchanged):

```ts
export function intentQuotas(
  target: number,
  intents: QueryIntent[],
  axis: 'maker' | 'retailer' = 'maker',
): Record<QueryIntent, number> {
  const weights = INTENT_WEIGHTS[axis];
  // ... existing body, with every `INTENT_WEIGHTS[i]` replaced by `weights[i]`
}
```

Update the two existing `intentQuotas` call sites in `buildQueryPack` and
`generateQueries` to pass `isRetailer(profile) ? 'retailer' : 'maker'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queries/`
Expected: PASS, including the untouched maker golden.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/queries/generate.ts src/core/queries/generate.test.ts
git commit -m "M5a: where-to-buy intent and per-axis intent weights"
```

---

### Task 5: Seller-shaped generation prompt

**Files:**

- Modify: `src/core/queries/generate.ts` (`INTENT_GUIDANCE`, `buildGenPrompt`)
- Test: `src/core/queries/generate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('tells the judge the brand is a shop and asks for shop-shaped questions', async () => {
  const judge = recordingJudge('{"where-to-buy":["nereden alınır?"]}');
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  await generateQueries(retailer, { judge, guard }, {
    count: 8,
    generatedAt: AT,
  });

  expect(judge.prompts[0]).toContain('sells products made by other companies');
  expect(judge.prompts[0]).toContain('where to buy');
});

it('keeps the maker generation prompt free of shop framing', async () => {
  const judge = recordingJudge('{"best-of":["best beginner piano?"]}');
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  await generateQueries({ ...retailer, businessType: 'maker' }, { judge, guard }, {
    count: 8,
    generatedAt: AT,
  });

  expect(judge.prompts[0]).not.toContain('sells products made by other companies');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/queries/generate.test.ts`
Expected: FAIL - neither phrase appears in the generated prompt.

- [ ] **Step 3: Implement**

Replace the single `INTENT_GUIDANCE` map with a per-axis pair:

```ts
const INTENT_GUIDANCE: Record<'maker' | 'retailer', Record<QueryIntent, string>> = {
  maker: {
    'best-of': 'shortlist questions ("what are the best ... for ...")',
    'where-to-buy': 'unused on the maker axis',
    comparison: 'questions weighing options or approaches when choosing',
    problem: 'questions describing a problem this product/service solves',
    trust: 'questions about reputation, reliability, or safety',
    local: 'questions scoped to a place ("... near me", "... in <city>")',
  },
  retailer: {
    'best-of': 'unused on the retailer axis',
    'where-to-buy':
      'questions about where to buy something ("where can I buy ...", "which shop sells ...", "best store for ...")',
    comparison:
      'questions weighing WHERE to buy - online shop vs local store, one kind of seller vs another',
    problem:
      'questions about buying problems a shop solves: delivery, returns, warranty, instalments, stock',
    trust: 'questions about reputation, reliability, or safety',
    local: 'questions scoped to a place ("... near me", "... in <city>")',
  },
};
```

In `buildGenPrompt`, take the axis, read guidance from it, and add one facts
line for a retailer directly after the `Brand:` line:

```ts
  if (axis === 'retailer') {
    facts.push(
      'Business: a shop. It sells products made by other companies, so buyers',
      'ask where to buy, not what to buy. Never write questions whose natural',
      'answer is a product brand.',
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queries/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/queries/generate.ts src/core/queries/generate.test.ts
git commit -m "M5a: seller-shaped generation prompt for retailers"
```

---

### Task 6: Golden pack for the retailer axis

**Files:**

- Create: `test/fixtures/queries/golden-retailer-pack.yml`
- Modify: `src/core/queries/golden.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('writes a retailer pack led by where-to-buy (golden)', async () => {
  const judge = recordingJudge(RETAILER_JUDGE_RESPONSE);
  const guard = new CostGuard({ maxSetupCostUsd: 0.05 });

  const { pack } = await generateQueries(
    RETAILER_PROFILE,
    { judge, guard },
    { count: 20, generatedAt: AT },
  );

  expect(toYaml(pack)).toBe(
    readFileSync(
      new URL('../../../test/fixtures/queries/golden-retailer-pack.yml', import.meta.url),
      'utf8',
    ),
  );
});
```

`RETAILER_JUDGE_RESPONSE` is a JSON object with 9 `where-to-buy`, 4
`comparison`, 4 `problem` and 4 `trust` strings (one above each quota, matching
the buffer the generator asks for). `RETAILER_PROFILE` is the retailer profile
from Task 4 with `category: 'Musical instrument shop'` and `locale: 'tr'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/queries/golden.test.ts`
Expected: FAIL - the fixture file does not exist (ENOENT).

- [ ] **Step 3: Create the fixture from the actual output**

Run the test once with `console.log(toYaml(pack))`, inspect the output by eye
(it must be where-to-buy 8 / comparison 4 / problem 3 / trust 3 for a no-geo
retailer, and no question whose answer would be a product brand), then write it
to `test/fixtures/queries/golden-retailer-pack.yml`. The existing
`golden-pack.yml` must NOT change - that is the maker regression proof.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/queries/ && git diff --stat test/fixtures/queries/golden-pack.yml`
Expected: PASS, and an EMPTY diff for `golden-pack.yml`.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/queries/golden-retailer-pack.yml src/core/queries/golden.test.ts
git commit -m "M5a: golden retailer pack, maker golden unchanged"
```

---

### Task 7: Publish the methodology change

**Files:**

- Modify: `METHODOLOGY.md`

- [ ] **Step 1: Write the section**

Add to the prompt-generation section:

> **Two prompt axes.** Buyer questions come in two shapes, chosen by what the
> brand is. A maker ("what are the best X") is measured against rival makers. A
> shop is measured on where-to-buy questions ("where can I buy X", "which store
> sells X") against rival shops, because product questions are answered with
> manufacturers: across 28 answers for one music retailer, manufacturers were
> named 21/16/10/8 times and not one rival shop was ever named. A score is
> therefore comparable only within one axis, never across the two.

- [ ] **Step 2: Verify the copy lint accepts it**

Run: `npx vitest run test/copy/`
Expected: PASS (no em-dash, no banned framing, roadmap terms untouched).

- [ ] **Step 3: Commit**

```bash
git add METHODOLOGY.md
git commit -m "M5a: publish the two prompt axes in METHODOLOGY"
```

---

### Task 8: Prove it on a real retailer

**Files:**

- Modify: `TASKS.md`

- [ ] **Step 1: Run the full gate**

Run: `npm run check && npm run format:check && npm run build`
Expected: all green, `dist/` emitted.

- [ ] **Step 2: Run discovery and generation live**

```bash
node dist/cli/index.js check www.do-re.com.tr --quick --yes --refresh --regenerate \
  --engines openai --max-cost 0.60 --json > /tmp/retail.json
```

Expected: `profile.json` carries `businessType: "retailer"`, and
`queries.yml` is led by `where-to-buy` questions in Turkish.

- [ ] **Step 3: Check the answers name shops**

```bash
node -e "
const e=require('/tmp/retail.json');
console.log('score:',e.score);
for(const r of e.shareOfVoice) console.log(r.share, r.name, r.isBrand?'(you)':'');
"
```

Expected: at least one rival RETAILER with a non-zero share, where the
2026-07-23 baseline had every retailer at 0 and manufacturers dominating. If
every shop is still 0, the fix has not worked - do not mark this done, record
what the answers named instead.

- [ ] **Step 4: Record the outcome in TASKS.md**

Update the M11 retail entry (`TASKS.md:220`) with the date, the command, the
before/after share-of-voice numbers, and the cost. State plainly if the result
was partial.

- [ ] **Step 5: Commit**

```bash
git add TASKS.md
git commit -m "M5a: live-verify the seller axis on a real retailer"
```

---

## Self-Review

**Spec coverage:** detection (Task 2, 3), profile field + user override (Task
1), pack shape and weights (Task 4), seller guidance (Task 5), maker golden
unchanged + three fallback failure modes (Tasks 2, 4, 6), METHODOLOGY (Task 7),
live acceptance (Task 8). No spec section is unimplemented.

**Deliberately unchanged, per spec:** scoring math, `SCORING_VERSION`,
`schema_version`. `INTENTS` in `src/core/queries/persist.ts` derives from
`QUERY_INTENTS`, so pack validation accepts the new intent with no edit.

**Type consistency:** `BusinessType` is used identically in `types.ts`,
`competitors.ts`, `profile.ts` and `discover.ts`; `intentQuotas(target,
intents, axis)` has one signature across Tasks 4 and 6; `parseDiscovery`
returns the same shape `discoverCompetitors` returns.

**Known risk:** `INTENT_WEIGHTS` changes shape from `Record<QueryIntent,
number>` to a per-axis map. It is exported, so any other importer must be
updated; `grep -rn "INTENT_WEIGHTS" src/` before Task 4 and fix any call site
in the same commit.
