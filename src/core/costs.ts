/**
 * Cost estimation and the spend guard.
 *
 * Hard rule #5: any operation that will spend LLM money goes through the cost
 * guard - estimate first, never spend silently. Hard rule #6: estimates are
 * estimates and say so (see {@link CostEstimate.assumptions}).
 */

/** Per-million-token pricing for a model. */
export interface ModelPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
  /**
   * Flat USD charged per request, on top of tokens. Some grounded engines bill a
   * search fee per call (Perplexity), which token-only pricing misses entirely.
   */
  perRequestUsd?: number;
}

/**
 * Checked-in pricing table. `lastUpdated` flags staleness; prices are USD per
 * million tokens and are approximate - good enough for a pre-run estimate, not
 * billing. Update the date when you touch the numbers.
 *
 * OpenAI rows retrieved 2026-07-17 from the official sheet
 * (https://developers.openai.com/api/docs/pricing). Two caveats an updater must
 * know: (1) `gpt-5.3-chat-latest` is NOT itself on that sheet - the page lists a
 * generic `chat-latest` row at $5/$30 and this inherits it, so the number is an
 * assumption, not a quote. (2) `-chat-latest` FLOATS: OpenAI repoints it at
 * whatever ChatGPT currently serves, so its price can change without any change
 * here. Re-verify at release (M17).
 *
 * Gemini + Perplexity rows verified live 2026-07-20 (M17 engine smoke):
 * - `gemini-flash-latest` $1.50/$9.00 from the official sheet
 *   (https://ai.google.dev/gemini-api/docs/pricing, quoting `gemini-3.5-flash`,
 *   which the alias resolved to live). That output rate EXPLICITLY includes
 *   thinking tokens, which is why the adapter counts `thoughtsTokenCount` as
 *   output. Same floating caveat as `-chat-latest`. The `gemini-2.5-flash` row
 *   is kept for historical snapshots only - that model now 404s.
 * - `sonar` token rates confirmed against Perplexity's own `usage.cost` on a
 *   real call ($1/$1), plus a flat `perRequestUsd` search fee of $0.005 that
 *   token-only pricing missed entirely (7x under-report on that call).
 *
 * Anthropic rows verified 2026-07-20 against the official sheet: `claude-haiku-4-5`
 * $1/$5 and `claude-sonnet-5` $3/$15 were both already correct. Note Sonnet 5 is
 * on introductory pricing ($2/$10) through 2026-08-31, so the row over-estimates
 * until then - deliberate, an estimate should not under-report spend.
 *
 * NOT modelled (known gap, logged for M17): Google Search grounding bills
 * $14/1,000 search queries on top of tokens - one request can trigger several -
 * so a grounded Gemini estimate is a floor, not a quote.
 */
export const MODEL_PRICING: {
  lastUpdated: string;
  models: Record<string, ModelPricing>;
} = {
  lastUpdated: '2026-07-20',
  models: {
    // Current generation (what ChatGPT serves / what we ask + judge with).
    'gpt-5.3-chat-latest': { inputPerMTokens: 5, outputPerMTokens: 30 },
    'gpt-5.6-sol': { inputPerMTokens: 5, outputPerMTokens: 30 },
    'gpt-5.6-terra': { inputPerMTokens: 2.5, outputPerMTokens: 15 },
    'gpt-5.6-luna': { inputPerMTokens: 1, outputPerMTokens: 6 },
    'gpt-5.5': { inputPerMTokens: 5, outputPerMTokens: 30 },
    'gpt-5.4': { inputPerMTokens: 2.5, outputPerMTokens: 15 },
    'gpt-5.4-mini': { inputPerMTokens: 0.75, outputPerMTokens: 4.5 },
    'gpt-5.4-nano': { inputPerMTokens: 0.2, outputPerMTokens: 1.25 },
    // Legacy - kept so existing snapshots and pinned --judge/--engines still
    // price, but no longer a default: ChatGPT does not serve these.
    'gpt-4o-mini': { inputPerMTokens: 0.15, outputPerMTokens: 0.6 },
    'gpt-4o': { inputPerMTokens: 2.5, outputPerMTokens: 10 },
    'claude-haiku-4-5': { inputPerMTokens: 1, outputPerMTokens: 5 },
    'claude-sonnet-5': { inputPerMTokens: 3, outputPerMTokens: 15 },
    'gemini-flash-latest': { inputPerMTokens: 1.5, outputPerMTokens: 9 },
    'gemini-3.5-flash': { inputPerMTokens: 1.5, outputPerMTokens: 9 },
    // Retired 2026-07-20: 404s ("no longer available to new users"). Kept only
    // so snapshots written before the switch still price.
    'gemini-2.5-flash': { inputPerMTokens: 0.3, outputPerMTokens: 2.5 },
    sonar: { inputPerMTokens: 1, outputPerMTokens: 1, perRequestUsd: 0.005 },
  },
};

/** Thrown when a model id is not present in {@link MODEL_PRICING}. */
export class UnknownModelError extends Error {
  constructor(public readonly model: string) {
    super(`No pricing for model "${model}" (add it to MODEL_PRICING)`);
    this.name = 'UnknownModelError';
  }
}

function pricingFor(model: string): ModelPricing {
  const p = MODEL_PRICING.models[model];
  if (!p) throw new UnknownModelError(model);
  return p;
}

/** USD cost of one call given token counts. */
export function costOfCall(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTokens +
    (outputTokens / 1_000_000) * pricing.outputPerMTokens +
    (pricing.perRequestUsd ?? 0)
  );
}

/** Assumptions baked into an estimate, surfaced so output can be honest. */
export interface EstimateAssumptions {
  avgInputTokens: number;
  avgOutputTokens: number;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  judgeSampleRate: number;
}

/** The default token/sampling assumptions for a run estimate. */
export const ESTIMATE_ASSUMPTIONS: EstimateAssumptions = {
  avgInputTokens: 200,
  avgOutputTokens: 500,
  judgeInputTokens: 700,
  judgeOutputTokens: 100,
  judgeSampleRate: 0.3, // M7: judge calls <= 30% of answers
};

/** Result of {@link estimateRun}: a pre-run cost estimate in USD. */
export interface CostEstimate {
  totalUsd: number;
  askUsd: number;
  judgeUsd: number;
  assumptions: EstimateAssumptions;
}

/**
 * Estimate the USD cost of asking `nPrompts` to each engine (by model id) plus
 * the sampled judge pass. Throws {@link UnknownModelError} for any model not in
 * the pricing table.
 */
export function estimateRun(
  nPrompts: number,
  engineModels: string[],
  judgeModel: string,
  assumptions: EstimateAssumptions = ESTIMATE_ASSUMPTIONS,
): CostEstimate {
  const askPerPrompt = engineModels.reduce(
    (sum, model) =>
      sum +
      costOfCall(
        pricingFor(model),
        assumptions.avgInputTokens,
        assumptions.avgOutputTokens,
      ),
    0,
  );
  const askUsd = nPrompts * askPerPrompt;

  const nAnswers = nPrompts * engineModels.length;
  const judgeCallCost = costOfCall(
    pricingFor(judgeModel),
    assumptions.judgeInputTokens,
    assumptions.judgeOutputTokens,
  );
  const judgeUsd = nAnswers * assumptions.judgeSampleRate * judgeCallCost;

  return { totalUsd: askUsd + judgeUsd, askUsd, judgeUsd, assumptions };
}

/**
 * Estimate the USD cost of a single judge-model call (discovery/query-gen).
 * Priced by the configured judge model. Unknown models fall back to the
 * priciest entry so the setup-budget authorization never under-estimates.
 */
export function estimateJudgeCallUsd(
  model: string,
  assumptions: EstimateAssumptions = ESTIMATE_ASSUMPTIONS,
): number {
  const pricing = MODEL_PRICING.models[model] ?? priciestPricing();
  return costOfCall(
    pricing,
    assumptions.judgeInputTokens,
    assumptions.judgeOutputTokens,
  );
}

/**
 * Estimate the USD cost of a single call with explicit token counts, priced by
 * the configured model (unknown -> priciest entry). Use this when the real
 * input/output budget is known, so the cost guard authorizes against reality.
 */
export function estimateCallUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING.models[model] ?? priciestPricing();
  return costOfCall(pricing, inputTokens, outputTokens);
}

/** Rough token count from character length (~4 chars/token) for pre-call estimates. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The most expensive pricing in the table - a conservative unknown-model
 * default, so an unpriced model never under-estimates the budget.
 *
 * Ranked by the cost of a REPRESENTATIVE CALL, not by summed per-token rates:
 * a flat `perRequestUsd` (Perplexity's per-search fee) is invisible to a rate
 * sum but dominates short calls. The judge asks for ~60 output tokens, well
 * inside the window where the fee outweighs the rates, so rate-only ranking
 * returned a row that was not actually the priciest and broke the
 * never-under-estimate guarantee this function exists to provide (rule #5).
 */
function priciestPricing(): ModelPricing {
  const referenceCost = (p: ModelPricing): number =>
    costOfCall(
      p,
      ESTIMATE_ASSUMPTIONS.judgeInputTokens,
      ESTIMATE_ASSUMPTIONS.judgeOutputTokens,
    );
  return Object.values(MODEL_PRICING.models).reduce((max, p) =>
    referenceCost(p) > referenceCost(max) ? p : max,
  );
}

/** Spend phase: pre-ASK setup (discovery + query-gen) vs the main run. */
export type CostPhase = 'setup' | 'main';

/**
 * Accumulates actual spend and enforces caps. Per the abort contract, hitting a
 * cap NEVER throws: {@link CostGuard.authorize} returns `false` and sets
 * {@link CostGuard.costCapped}, and the caller stops.
 *
 * Authorizing RESERVES the projected cost, and {@link CostGuard.settle}
 * replaces that hold with the real figure once the call returns. Without the
 * reservation, `authorize` compared only against RECORDED spend - and recording
 * happens after a call completes - so every concurrently in-flight call was
 * authorized against a total that excluded all the others. Measured live
 * 2026-07-20: `--max-cost 0.20` spent $0.3481, a 74% breach (hard rule #5).
 */
export class CostGuard {
  private readonly spent: Record<CostPhase, number> = { setup: 0, main: 0 };
  /** Authorized-but-not-yet-settled holds, so in-flight calls count against the cap. */
  private readonly reserved: Record<CostPhase, number> = { setup: 0, main: 0 };
  private capped = false;

  constructor(
    private readonly caps: {
      maxCostUsd?: number;
      maxSetupCostUsd?: number;
    } = {},
  ) {}

  get spentUsd(): number {
    return this.spent.setup + this.spent.main;
  }

  get costCapped(): boolean {
    return this.capped;
  }

  /**
   * Return whether a projected spend of `usd` in `phase` is allowed. If it
   * would exceed the setup cap (for setup spends) or the total cap, mark
   * `costCapped` and return `false`. Never throws.
   */
  authorize(usd: number, phase: CostPhase = 'main'): boolean {
    const { maxSetupCostUsd, maxCostUsd } = this.caps;
    // Committed = already spent PLUS everything currently in flight. Checking
    // spend alone let concurrent calls each claim the same headroom.
    const committedSetup = this.spent.setup + this.reserved.setup;
    const committedTotal =
      this.spentUsd + this.reserved.setup + this.reserved.main;
    if (
      phase === 'setup' &&
      maxSetupCostUsd !== undefined &&
      committedSetup + usd > maxSetupCostUsd
    ) {
      this.capped = true;
      return false;
    }
    if (maxCostUsd !== undefined && committedTotal + usd > maxCostUsd) {
      this.capped = true;
      return false;
    }
    this.reserved[phase] += usd;
    return true;
  }

  /**
   * Close out an authorized call: release its reservation and book what it
   * actually cost. Pass `actualUsd: 0` when the call failed or was abandoned,
   * so the hold does not leak and strangle the remaining budget.
   */
  settle(
    reservedUsd: number,
    actualUsd: number,
    phase: CostPhase = 'main',
  ): void {
    this.reserved[phase] = Math.max(0, this.reserved[phase] - reservedUsd);
    this.spent[phase] += actualUsd;
  }

  /**
   * Record actual spend for a call that carried NO reservation.
   *
   * Do not pair this with {@link CostGuard.authorize} - that reserves, and only
   * {@link CostGuard.settle} releases the hold. Using `record` after
   * `authorize` leaks the reservation and permanently shrinks the budget.
   */
  record(usd: number, phase: CostPhase = 'main'): void {
    this.spent[phase] += usd;
  }
}
