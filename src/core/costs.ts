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
 * here. Re-verify at release (M17). The non-OpenAI rows predate this pass and
 * are stale in the same way `gpt-4o` was - see the TASKS follow-up.
 */
export const MODEL_PRICING: {
  lastUpdated: string;
  models: Record<string, ModelPricing>;
} = {
  lastUpdated: '2026-07-17',
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
    'gemini-2.5-flash': { inputPerMTokens: 0.3, outputPerMTokens: 2.5 },
    sonar: { inputPerMTokens: 1, outputPerMTokens: 1 },
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
    (outputTokens / 1_000_000) * pricing.outputPerMTokens
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

/** The most expensive pricing in the table - a conservative unknown-model default. */
function priciestPricing(): ModelPricing {
  return Object.values(MODEL_PRICING.models).reduce((max, p) =>
    p.inputPerMTokens + p.outputPerMTokens >
    max.inputPerMTokens + max.outputPerMTokens
      ? p
      : max,
  );
}

/** Spend phase: pre-ASK setup (discovery + query-gen) vs the main run. */
export type CostPhase = 'setup' | 'main';

/**
 * Accumulates actual spend and enforces caps. Per the abort contract, hitting a
 * cap NEVER throws: {@link CostGuard.authorize} returns `false` and sets
 * {@link CostGuard.costCapped}, and the caller stops. `record` logs actuals.
 */
export class CostGuard {
  private readonly spent: Record<CostPhase, number> = { setup: 0, main: 0 };
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
    if (
      phase === 'setup' &&
      maxSetupCostUsd !== undefined &&
      this.spent.setup + usd > maxSetupCostUsd
    ) {
      this.capped = true;
      return false;
    }
    if (maxCostUsd !== undefined && this.spentUsd + usd > maxCostUsd) {
      this.capped = true;
      return false;
    }
    return true;
  }

  /** Record actual spend after a call completes. */
  record(usd: number, phase: CostPhase = 'main'): void {
    this.spent[phase] += usd;
  }
}
