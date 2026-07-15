# How the AI Visibility Score is calculated

This document is the published methodology for the score Optifeed Visibility
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
positionScore = mean over all N answers of (1 / rank when mentioned, else 0)
sentimentAvg  = mean(+1 positive, 0 neutral, -1 negative) over mentioned answers
sentimentMod  = 1 + 0.15 * sentimentAvg            # 0.85 .. 1.15

raw   = (0.60 * mentionRate + 0.40 * positionScore) * sentimentMod
score = round(clamp(raw, 0, 1) * 100)
```

Weights: mention rate 0.60, position 0.40, sentiment swing +/- 15%.

`positionScore` is coverage-aware: it averages `1 / rank` over **all** answers,
not only the ones that mention you, so an answer that never mentions your brand
contributes 0. Being ranked first when you do appear cannot mask being absent
from half the conversation.

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
Grounded engines (which cite live sources) weight higher than parametric ones:

```
weight(engine) = grounded ? 1.5 : 1.0
composite = round( sum(score * weight) / sum(weight) )
```

Worked example. A grounded engine scoring 60 and a parametric engine scoring 40:

```
composite = (60 * 1.5 + 40 * 1.0) / (1.5 + 1.0) = 130 / 2.5 = 52
```

## Step 4 - share of voice and sources

Share of voice counts how often your brand and each competitor are mentioned
across all answers, as a percentage of the total. Sources aggregate the domains
that grounded engines cite, most-cited first. Both are descriptive; only the
composite is the headline score.

## Honesty notes

- The score is a sampled estimate and is labeled as one everywhere it appears.
- Grounded and parametric engines are reported separately, never merged into a
  single opaque number without the breakdown.
- Partial runs (an engine skipped, the cost cap reached) are surfaced, not
  hidden. A capped run reports what it measured and flags what it did not.
