/**
 * The `shopping` orchestrator (M12a) - the same seam `runCheck` is, one level
 * down. Both entrypoints (CLI, MCP) adapt over THIS; no pipeline logic lives in
 * `cli/` or `mcp/` (hard rule #1).
 *
 * Reuse the brand profile (M4) for category and locale, take the merchant's own
 * product list (there is no discovery), write two prompt layers per product,
 * ask the engines through the SAME `askAll` the brand check uses, score each
 * product, and assemble the envelope whose headline is the ranking delta.
 *
 * Everything that spends or touches the network is injected, so tests drive the
 * whole flow with no network (hard rule #3). Every spend goes through the cost
 * guard, and hitting the cap returns a partial run flagged `costCapped` rather
 * than throwing (hard rule #5).
 */
import { CostGuard, type CostEstimate } from '../costs.js';
import { discover, type ProfileFs } from '../discovery/index.js';
import {
  createEngineAdapters,
  type AskMode,
  type EngineAdapter,
  askAll,
} from '../engines/index.js';
import { createFetcher, type Fetcher } from '../fetcher/index.js';
import {
  analyzeProductAnswer,
  buildShoppingEnvelope,
  generateProductQueries,
  nodeShoppingFs,
  parseProductsFile,
  refineProductMentions,
  resolveProducts,
  saveShoppingRun,
  scoreProduct,
  type AnalyzedAnswer,
  type ProductLayer,
  type ProductMention,
  type ShoppingEnvelope,
  type ShoppingFs,
  type SkuReport,
} from '../shopping/index.js';
import type {
  EngineAnswer,
  JudgeClient,
  ProductEntity,
  RunHonesty,
  RunSpend,
} from '../types.js';
import {
  priceRun,
  type AbortReason,
  type ConfirmContext,
  type ProgressEvent,
} from './check.js';

/** Injected collaborators. Anything that spends or hits the network lives here. */
export interface RunShoppingDeps {
  /** Fetcher (M2), for profile discovery; defaults to a real-network fetcher. */
  fetcher?: Fetcher;
  /** Engine adapters (M6); their availability drives `skippedEngines`. */
  adapters?: EngineAdapter[];
  /** Judge for discovery, prompt writing, and the product judge pass. */
  judge?: JudgeClient;
  /** Two-phase cost guard; defaults to uncapped. */
  guard?: CostGuard;
  /** Profile persistence (M4). */
  profileFs?: ProfileFs;
  /** Shopping-run persistence (M12a) - also used to read `--products-file`. */
  shoppingFs?: ShoppingFs;
  /** Clock, injected for deterministic `generatedAt`. */
  now?: () => string;
  /** Confirmation gate before the main spend. Skipped entirely when `yes`. */
  confirm?: (ctx: ConfirmContext) => Promise<boolean>;
  /** Env for the default adapter set, when `adapters` is not injected. */
  env?: Record<string, string | undefined>;
  /** Progress sink; defaults to a no-op. */
  onProgress?: (event: ProgressEvent) => void;
}

/** Options mirroring the `shopping` command's flags. */
export interface RunShoppingOptions {
  /** State dir for the profile and saved runs (from `resolveStateDir`). */
  stateDir: string;
  /** The merchant's products, IN THEIR RANKING ORDER. */
  products?: ProductEntity[];
  /** Path to a products file; when set it wins over `products`. */
  productsFile?: string;
  // discovery
  refresh?: boolean;
  brand?: string;
  category?: string;
  samplePages?: number;
  // engines / scoring
  mode?: AskMode;
  concurrency?: number;
  judgeRateCap?: number;
  // control
  /** Skip the confirmation gate (agents / CI). */
  yes?: boolean;
  /** Persist the profile and the run (default true). */
  persist?: boolean;
}

/**
 * Fields both arms of {@link RunShoppingResult} carry, whatever the outcome.
 *
 * `spend` is here rather than on the completed arm alone because discovery and
 * prompt writing happen BEFORE the confirmation gate: declining still billed
 * for the setup phase, and reporting spend only on success would tell a user
 * who declined precisely to avoid spending that the run was free (rule #6).
 */
interface RunShoppingCommon {
  /** Human-readable notes (dropped products, template fallbacks, aborts). */
  notes: string[];
  /** What the run spent, from the cost guard. Present even on an abort. */
  spend?: RunSpend;
}

/** A run that reached the engines and produced an envelope. */
export interface RunShoppingCompleted extends RunShoppingCommon {
  aborted: false;
  /** The shopping envelope. Guaranteed by the type once `aborted` is false. */
  envelope: ShoppingEnvelope;
  /**
   * Path the run was saved to, if persisted this run. Only a completed run has
   * one: an abort returns before `saveShoppingRun`, so carrying the field on
   * the abort arm would describe a file that cannot exist.
   */
  savedPath?: string;
}

/** A run that stopped before querying any engine. */
export interface RunShoppingAborted extends RunShoppingCommon {
  aborted: true;
  /**
   * Why the run stopped. REQUIRED on this arm, so no return site can report an
   * abort it does not explain. The taxonomy is `check`'s, not a second one:
   * a caller mapping aborts to an exit code or an error asks the shared
   * `isAbortFailure` rather than comparing the value itself.
   */
  abortReason: AbortReason;
}

/**
 * Outcome of {@link runShopping} - a discriminated union on `aborted`, the same
 * shape `RunCheckResult` has, so both orchestrators narrow identically.
 *
 * `envelope` and `abortReason` are each required on exactly one arm, so
 * "aborted with no reason" and "completed with no envelope" are not
 * representable, and a completed run needs no non-null assertion.
 */
export type RunShoppingResult = RunShoppingCompleted | RunShoppingAborted;

/** Which product/layer pairs asked for a given prompt. */
interface PromptOwner {
  productIndex: number;
  layer: ProductLayer;
}

/**
 * Run the `shopping` pipeline for `domain`. Never throws for a partial run - a
 * cost cap, a skipped engine, or a degraded profile come back on the envelope.
 * It DOES throw for an unusable product list, which is a usage error rather
 * than a partial result.
 */
export async function runShopping(
  domain: string,
  deps: RunShoppingDeps = {},
  opts: RunShoppingOptions,
): Promise<RunShoppingResult> {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const fetcher = deps.fetcher ?? createFetcher();
  const guard = deps.guard ?? new CostGuard();
  const adapters =
    deps.adapters ?? createEngineAdapters({ env: deps.env ?? process.env });
  const shoppingFs = deps.shoppingFs ?? nodeShoppingFs();
  const persist = opts.persist ?? true;
  const report = deps.onProgress ?? ((): void => undefined);
  const notes: string[] = [];

  // The product list first: a bad list is a usage error, and finding it out
  // AFTER discovery has already billed a judge call would be rude.
  const listed = opts.productsFile
    ? parseProductsFile(
        await shoppingFs.readFile(opts.productsFile),
        opts.productsFile,
      )
    : (opts.products ?? []);
  const resolved = resolveProducts(listed);
  const products = resolved.products;
  notes.push(...resolved.notes);

  report({ kind: 'discovery-start' });
  const discovery = await discover(
    domain,
    {
      fetcher,
      judge: deps.judge,
      guard,
      fs: deps.profileFs,
      now,
    },
    {
      stateDir: opts.stateDir,
      refresh: opts.refresh,
      brand: opts.brand,
      category: opts.category,
      samplePages: opts.samplePages,
      persist,
    },
  );
  const profile = discovery.profile;
  report({ kind: 'discovery-done', brand: profile.brand });
  if (discovery.competitorNote) notes.push(discovery.competitorNote);

  report({ kind: 'queries-start' });
  const generated = await generateProductQueries(
    profile,
    products,
    { judge: deps.judge, guard },
    { generatedAt: now() },
  );
  notes.push(...generated.notes);

  // One prompt, many owners: two products in the same category ask the same
  // question, so it is asked ONCE and scored for each of them. Cheaper, and it
  // makes the ranking delta a comparison on one shared shelf.
  const owners = new Map<string, PromptOwner[]>();
  for (const { prompt, productIndex, layer } of generated.prompts) {
    const existing = owners.get(prompt);
    if (existing) existing.push({ productIndex, layer });
    else owners.set(prompt, [{ productIndex, layer }]);
  }
  const prompts = [...owners.keys()];
  report({ kind: 'queries-done', prompts });

  // No `no-prompts` guard here, unlike `check`, and deliberately so: this
  // pipeline cannot reach the gate with nothing to ask. `resolveProducts`
  // throws on an empty list rather than returning one, and every surviving
  // product gets at least its reputation prompt, which is templated from the
  // product NAME alone ("is the <name> worth it?") with no judge, descriptor,
  // or category needed. A guard here would be dead code; the test
  // "always has at least one prompt to ask" is what keeps that true.

  // Gate the main ASK spend (bypassable with `yes`, hard rule #8). Spending is
  // allowed ONLY when explicitly confirmed; a consumer that wires neither must
  // not silently spend.
  const availableEngines = adapters.filter((a) => a.available());
  if (!opts.yes) {
    if (!deps.confirm) {
      notes.push(
        'Aborted before spending: engine queries need confirmation. Pass yes to run non-interactively, or provide a confirm handler.',
      );
      return {
        aborted: true,
        abortReason: 'unconfirmed',
        notes,
        spend: guard.spendBreakdown,
      };
    }
    const estimate: CostEstimate | undefined = priceRun(
      prompts.length,
      availableEngines,
      deps.judge,
      opts.mode === 'grounded',
    );
    const ok = await deps.confirm({
      estimate,
      nPrompts: prompts.length,
      engines: availableEngines.map((a) => a.id),
      nProducts: products.length,
    });
    if (!ok) {
      notes.push('Run aborted at the cost confirmation.');
      return {
        aborted: true,
        abortReason: 'declined',
        notes,
        spend: guard.spendBreakdown,
      };
    }
  }

  // Ask (M6): the same runner the brand check uses, so a total engine failure
  // never kills the run and the cost cap returns partial answers.
  const total = prompts.length * availableEngines.length;
  report({ kind: 'ask-start', total });
  let done = 0;
  const asked = await askAll(prompts, adapters, {
    mode: opts.mode,
    guard,
    concurrency: opts.concurrency,
    onAnswered: () => {
      done += 1;
      report({ kind: 'ask-answered', done, total });
    },
  });
  report({ kind: 'ask-done', answered: asked.answers.length, total });

  // Score: fan each answer out to every product that asked its prompt.
  report({ kind: 'scoring-start' });
  const generatedAt = now();
  const perProduct = products.map(() => ({
    visibility: [] as AnalyzedAnswer[],
    reputation: [] as AnalyzedAnswer[],
  }));
  // Flat, index-aligned arrays for the judge pass (rows[i] describes answersFor[i]).
  const rows: ProductMention[] = [];
  const answersFor: EngineAnswer[] = [];
  const slots: { productIndex: number; layer: ProductLayer }[] = [];

  for (const answer of asked.answers) {
    for (const owner of owners.get(answer.prompt) ?? []) {
      const product = products[owner.productIndex];
      if (!product) continue;
      rows.push(analyzeProductAnswer(answer, product));
      answersFor.push(answer);
      slots.push(owner);
    }
  }

  let judged = 0;
  if (deps.judge) {
    const refined = await refineProductMentions(
      rows,
      answersFor,
      { judge: deps.judge, guard },
      { judgeRateCap: opts.judgeRateCap },
    );
    refined.results.forEach((result, i) => (rows[i] = result));
    judged = refined.judged;
  }

  rows.forEach((result, i) => {
    const slot = slots[i];
    const answer = answersFor[i];
    if (!slot || !answer) return;
    const bucket = perProduct[slot.productIndex];
    if (!bucket) return;
    bucket[slot.layer].push({ answer, result });
  });

  // How many category prompts each product ASKED FOR. Counted from the
  // generated pack, never from the answers: a cost cap or a failed engine
  // leaves the questions written but unanswered, and reporting that as "no
  // questions were asked" blames the merchant's product list for the run's
  // problem (and told them to add a descriptor they may already have).
  const requested = products.map(
    (_, i) =>
      generated.prompts.filter(
        (p) => p.productIndex === i && p.layer === 'visibility',
      ).length,
  );

  const skus: SkuReport[] = products.map((product, i) => {
    const bucket = perProduct[i] ?? { visibility: [], reputation: [] };
    return scoreProduct({
      product,
      categoryPrompts: requested[i] ?? 0,
      visibility: bucket.visibility,
      reputation: bucket.reputation,
      owners: products,
    });
  });
  report({ kind: 'scoring-done' });

  // Assemble honesty from ALL independent signals - a cap, a skipped engine, an
  // engine that answered only some prompts, an engine that answered from
  // several models, or a degraded profile each make the run partial, and
  // dropping any one relaunders it as complete (rule #6).
  const honesty: RunHonesty = {
    costCapped: guard.costCapped ? true : undefined,
    skippedEngines:
      asked.skippedEngines.length > 0 ? asked.skippedEngines : undefined,
    partialEngines:
      asked.partialEngines.length > 0 ? asked.partialEngines : undefined,
    mixedModelEngines:
      asked.mixedModelEngines.length > 0 ? asked.mixedModelEngines : undefined,
    degraded: profile.degraded ? true : undefined,
  };

  const envelope = buildShoppingEnvelope({
    profile,
    products,
    skus,
    answers: asked.answers,
    rowsAnalyzed: rows.length,
    judged,
    notes,
    honesty,
    // Read from the guard, not by summing answers: discovery, prompt writing
    // and the judge pass all spend without producing an answer to sum. Taken
    // AFTER scoring so the judge pass is included.
    spend: guard.spendBreakdown,
    generatedAt,
  });

  let savedPath: string | undefined;
  if (persist) {
    savedPath = await saveShoppingRun(envelope, opts.stateDir, shoppingFs);
  }

  return {
    envelope,
    aborted: false,
    savedPath,
    notes,
    spend: guard.spendBreakdown,
  };
}
