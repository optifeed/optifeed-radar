/**
 * How a run's actual spend is phrased, in one place.
 *
 * Shared by the terminal and HTML renderers so the two cannot drift - the same
 * reason `variance.ts` exists, after the HTML report was found missing a
 * caveat the terminal already printed.
 */
import type { RunSpend } from '../types.js';

/** USD to a fixed 4 decimals: sub-cent runs are real and must not round to $0.00. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * One honest line describing what a run cost, or undefined when the run
 * carries no recorded spend.
 *
 * Returning undefined (rather than a $0.0000 line) is the point: an absent
 * figure means "not recorded", and printing a zero would tell the user a paid
 * run was free. Same rule as rendering an unmeasured score as "not assessed".
 *
 * The setup/engine split is shown because setup money (brand discovery and
 * query generation) is spent BEFORE the confirm gate's main ask, so a user
 * reconciling a bill or tuning `--max-cost` needs to see where it went.
 */
export function spendLine(spend: RunSpend | undefined): string | undefined {
  if (!spend) return undefined;
  // A zero total is NOT evidence the run was free. It is also what an unpriced
  // model produces, because a MODEL_PRICING miss records $0 for every call -
  // so "$0.0000" could be reporting an unbilled run or a run whose cost we
  // simply failed to compute. Since the two are indistinguishable here, say
  // nothing rather than assert a figure that might be a lie (rule #6).
  if (spend.totalUsd <= 0) return undefined;
  return `Run cost: ${formatUsd(spend.totalUsd)} (setup ${formatUsd(
    spend.setupUsd,
  )}, engines ${formatUsd(spend.mainUsd)})`;
}
