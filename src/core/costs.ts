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
 */
export const MODEL_PRICING: {
  lastUpdated: string;
  models: Record<string, ModelPricing>;
} = {
  lastUpdated: '2026-07-15',
  models: {
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
