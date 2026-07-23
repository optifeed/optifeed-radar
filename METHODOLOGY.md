# How the AI Visibility Score is calculated

This document is the published methodology for the score Optifeed Radar
reports. The weights below are the source of truth in code
(`SCORE_WEIGHTS` in `src/core/scoring/score.ts`); if they change, this file and
its worked examples change with them.

The score is an estimate. It reflects how often and how prominently AI answer
engines mention your brand for a set of buyer questions, on the runs you did.
Engines vary between runs, samples are finite, and language is messy. Treat the
number as a directional signal, not a precise measurement.

## Which questions feed the score

Only unbranded buyer questions count toward the AI Visibility Score - questions
that never name your brand ("what are the best gluten-free snacks?"), so a
mention means the engine surfaced you unprompted. Questions that name your brand
by design (the "trust" intent, e.g. "is Wefood reliable?") are kept out of the
score, since naming the brand guarantees a mention. Those are reported
separately as a reputation summary (positive / neutral / negative sentiment) and
never inflate the headline number.

These questions are GENERATED approximations of how a buyer might ask, not real
user prompt data. We do not have a panel of what people actually type into these
engines (the data hosted platforms sell), so we model realistic buyer questions
from your brand profile instead. That is why the query pack is editable: if the
generated questions do not match how your buyers really ask, edit them and rerun.
The score reflects the questions you ran, not the whole universe of buyer intent.

### Two question axes: makers and shops

Buyer questions come in two shapes, and which one you get is decided by what
your business is (discovery classifies it, and you can correct it by editing
`businessType` in `profile.json`).

A MAKER, who sells its own products, is measured on product questions ("what
are the best gluten-free snacks?") against rival makers.

A SHOP, which sells other companies' products, is measured on where-to-buy
questions ("where can I buy a piano?", "which shop sells acoustic guitars?")
against rival shops. This is not a cosmetic difference. Product questions are
answered with manufacturers: across 28 answers for one music retailer, makers
were named 21, 16, 10 and 8 times while not one rival shop was named even once.
Scoring a shop on product questions therefore reports a 0 that says nothing
about the shop, so those questions are not asked for a shop at all.

A score is comparable only within one axis. A shop's number and a maker's
number answer different questions and should never be compared to each other.

## Step 1 - mention detection (per answer)

Each engine answer is analyzed for whether your brand appears.

- Pass 1 is deterministic: the brand name, its aliases, and its domain are
  matched case- and accent-insensitively, on word boundaries (so "Ace" does not
  match "space"). Known competitors are matched the same way, which gives share
  of voice without guessing at arbitrary entities.
- Pass 2 uses an AI judge model, and only for ambiguous answers (for example a
  brand whose name is also a common word, like "Orange"). Judge calls are capped
  at 30% of all answers and run through the cost guard, so pass 2 never blows the
  budget. If the cap or the budget is reached, the remaining answers keep their
  pass-1 result and the run says so.

For each answer we record: mentioned (yes/no), position (1-based rank among the
detected brands, or none), sentiment (positive / neutral / negative), the
entities present (for share of voice), and any cited domains (grounded engines).

## Step 2 - per-engine score (0-100)

For one engine, over its N answers:

```
mentionRate   = mentions / N                       # 0..1
positionScore = mean over all N answers of the position credit below
sentimentAvg  = mean(+1 positive, 0 neutral, -1 negative) over mentioned answers
sentimentMod  = 1 + 0.15 * sentimentAvg            # 0.85 .. 1.15

raw   = (0.60 * mentionRate + 0.40 * positionScore) * sentimentMod
score = round(clamp(raw, 0, 1) * 100)

# position credit per answer:
#   mentioned with a parsed rank R  ->  1 / R
#   mentioned but no rank parsed     ->  1 / 4   (mid-list default)
#   not mentioned                    ->  0
```

Weights: mention rate 0.60, position 0.40, sentiment swing +/- 15%, unranked
mid-list rank 4.

`positionScore` is coverage-aware: it averages the per-answer position credit
over **all** answers, not only the ones that mention you, so an answer that
never mentions your brand contributes 0. Being ranked first when you do appear
cannot mask being absent from half the conversation. An answer that mentions you
in prose without a numbered rank is not absent, so it earns a conservative
mid-list credit (rank 4) rather than 0.

Worked example. An engine with 5 answers, mentioned in 3 of them at positions
1, 2, and 3, with sentiments positive, neutral, neutral:

```
mentionRate   = 3 / 5 = 0.60
positionScore = (1/1 + 1/2 + 1/3 + 0 + 0) / 5 = 1.833 / 5 = 0.367
sentimentAvg  = (1 + 0 + 0) / 3 = 0.333  ->  sentimentMod = 1.05
raw   = (0.60 * 0.60 + 0.40 * 0.367) * 1.05 = 0.507 * 1.05 = 0.532
score = round(53.2) = 53
```

(`avgPosition`, the average rank when mentioned, is reported alongside the score
for context but is not the value used in the formula.)

## Step 3 - composite score (the headline number)

The headline AI Visibility Score is a weighted mean of the per-engine scores.
An engine that answers from live retrieved sources weights higher than one
answering from its trained weights:

```
retrievalRate(engine) = answers that actually retrieved / answers
weight(engine) = 1.0 + 0.5 * retrievalRate(engine)
composite      = round( sum(score * weight) / sum(weight) )
```

An engine that retrieved on every answer weights 1.5; one that never retrieved
weights 1.0.

Worked example. An engine that retrieved on every answer scoring 60, and a
parametric engine scoring 40:

```
composite = (60 * 1.5 + 40 * 1.0) / (1.5 + 1.0) = 130 / 2.5 = 52
```

Asking for grounded mode is not the same as searching. A grounded-mode request
is one the model can decline: on a live run in July 2026, 7 of 8 ChatGPT
answers ran no search and cited nothing, while Gemini searched on 7 of 7. The
premium is for retrieval-backed answers, so it is earned per answer rather than
granted for the request. An engine that searched on only some of its answers
says so in the report ("searched in 1 of 8 answers").

An answer counts as retrieved when the engine reported the search queries it
ran, the sources it cited, or both. This is only read as a signal for engines
known to report that evidence (currently OpenAI, Gemini and Perplexity, the
last of which reports citations but never queries). For any other engine the
requested mode is trusted, since absent evidence there means "not reported",
not "did not search".

## Retrieval variance (how wide is each estimate)

Engines differ in how much they rewrite your prompt before searching, so they
differ in run-to-run stability. As of the Profound fanout study (Apr 2026),
ChatGPT rewrites heavily (~91% unique queries per run) while Perplexity is
near-stable (~14%). A high-variance engine's per-engine score is therefore a
wider estimate and benefits from more samples. We surface this as a plain
confidence qualifier next to those engines - it does NOT adjust the number
(that would be false precision). It is shown only for engines that actually
retrieved: an engine that ran no search cannot have rewritten your prompt
before searching. The per-engine variance values are approximate
and dated, like the price table, and re-verified at release; anthropic and
gemini are inferred and least certain.

## Step 4 - share of voice and sources

Share of voice counts how often your brand and each competitor are mentioned
across all answers, as a percentage of the total. Sources aggregate the domains
that grounded engines cite, most-cited first. Both are descriptive; only the
composite is the headline score.

## Product-level scores (`shopping`)

`shopping` measures individual products you name, one level below the brand.
The maths is the same: Steps 2 and 3 above are reused unchanged, so a product's
0-100 means what a brand's does. What differs is what gets detected, and what
gets reported as the headline.

**There is no aggregate shopping score.** The headline of a shopping run is the
RANKING DELTA: your own order (the order you list the products in, best first)
against the order engines actually recommend. Per-product 0-100 numbers appear
inside each product's section; they are never rolled up into a single number,
because one score per run belongs to `check`.

**Detection has no known rival list.** For a brand, competitors come from the
brand profile and are matched by name. One level down there is no such list: the
rival products in an answer are whatever the engine happened to recommend. So
pass 1 parses the answer's own recommendation list - the shelf - out of its
numbered lists, bullets, headings and bold lead-ins, and reads the product's
rank off that. A mention with no shelf position gets the same mid-list default
(1/4) an unranked brand mention gets. That parser is a heuristic over messy
prose and will always trail real answer formats, which is what the judge pass
is for.

**The judge pass is capped at 50%, not 30%.** Product names are messier than
brand names: single-word names, model codes, and engines that recommend in
prose all land as ambiguous. Each run reports the cap it ran with and how many
rows it actually judged.

**Two layers per product**, the same split as unbranded vs branded questions:
three category buying questions that never name the product (these produce the
visibility number), and one that names it (reputation, sentiment only, kept out
of the number).

**Product-level share of voice** counts what the engines recommended instead,
once per answer rather than once per mention. When a product is absent this
leads its section: the shelf that beat it is the useful half of a zero.

**Three ways a product can have no number, never collapsed into one:**

| state                         | what it means                                                                                           | what fixes it                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| no category questions asked   | the product had no descriptor and the store had no usable category, so the questions were never written | give the product a descriptor                      |
| questions went unanswered     | the questions existed but the run could not complete them (cost cap, engine failure)                    | raise `--max-cost`, or rerun                       |
| not recommended in any answer | a real zero: the questions ran and engines named other products                                         | the shelf in that section is the competitive intel |

A product engines never named has no AI rank at all, rather than being placed
last: "absent from the conversation" and "ranked bottom" are different claims.

## Scoring version

This methodology is version 3 (`SCORING_VERSION` in `src/core/scoring/score.ts`).
Version 3 changed the composite: the retrieval premium is earned by answers
that actually retrieved, where version 2 granted it to any engine asked for
grounded mode. A run where every grounded answer really searched scores the
same under both.
The score is not comparable across a methodology change, so each run records its
scoring version and `diff` flags a comparison whose two runs used different
versions (or one predates versioning) as methodology-driven, not a real change.

## Honesty notes

- The score is a sampled estimate and is labeled as one everywhere it appears.
- Grounded and parametric engines are reported separately, never merged into a
  single opaque number without the breakdown.
- Partial runs (an engine skipped, the cost cap reached) are surfaced, not
  hidden. A capped run reports what it measured and flags what it did not.
- The questions are generated approximations, not real user prompt data, and the
  pack is editable so you can make them match how your buyers actually ask.
- High-variance engines are flagged as wider estimates; retrieval variance is
  framing only and never changes the score.
- In `shopping`, a missing product number always says WHICH of the three causes
  above produced it, so a capped run is never reported as a product the
  merchant failed to describe.
