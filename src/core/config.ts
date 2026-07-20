/**
 * Config resolution, key detection, judge-model selection, and state-dir
 * resolution (M1). Pure and injectable - no direct env/prompt/fs access here so
 * the whole matrix is unit-testable without a real environment.
 */
import { costOfCall, ESTIMATE_ASSUMPTIONS, MODEL_PRICING } from './costs.js';
import type { EngineId } from './types.js';

/** Which env var holds each engine's API key. */
export const ENGINE_KEY_ENV: Record<EngineId, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

/**
 * Default judge model per engine.
 *
 * NOT simply the cheapest any more. The judge does competitor discovery, which
 * is factual RECALL, and cheap models do not recall - they fabricate. Measured
 * 2026-07-17 on a Turkish retailer (doremusic; ground truth verified on the
 * web): `gpt-4o-mini` returned 0/10 real rivals and missed Zuhal Müzik, the
 * obvious one, inventing a different plausible-sounding list on every run.
 * `gpt-5.4` returned Zuhal Müzik, MyDukkan and Cangöz Müzik, ranked first.
 * The judge is cheap to upgrade: 2 one-shot setup calls per brand (cached),
 * and the scoring judge only fires on ambiguous answers, capped at
 * `JUDGE_RATE_CAP` (it fired 0 times across every live run so far).
 */
export const DEFAULT_JUDGE_MODELS: Record<EngineId, string> = {
  openai: 'gpt-5.4',
  // Was `claude-haiku-4-5`. The rule above says the judge is NOT the cheapest -
  // it does factual RECALL and cheap models fabricate - but the anthropic entry
  // still named the cheap tier, so an added Anthropic key silently downgraded
  // the judge (the risk logged at M11). Sonnet 5 ($3/$15) also sits just above
  // gpt-5.4 ($2.50/$15), so the cheapest-available rule now keeps gpt-5.4 as
  // judge on a mixed run instead of swapping to a cheap-tier model.
  anthropic: 'claude-sonnet-5',
  // `gemini-2.5-flash` 404s as of 2026-07-20 ("no longer available to new
  // users"), which made a Gemini-judged run fail on every setup call.
  gemini: 'gemini-flash-latest',
  perplexity: 'sonar',
};

/**
 * Which provider serves a model id, including ids that are no longer a default.
 *
 * Callers used to reverse-look-up the engine by exact match against
 * {@link DEFAULT_JUDGE_MODELS} and silently fall back to "the first available
 * engine" on a miss. When a default changes, every id the tool previously told
 * users to pin misses - so `--judge gemini-2.5-flash` built an OpenAI adapter
 * and posted a Gemini model id to api.openai.com. Matching on the id's own
 * prefix keeps legacy and future ids routing to the provider that owns them.
 *
 * Returns undefined when the id belongs to no known provider; callers must
 * surface that as an honest error rather than guessing an engine.
 */
export function engineForModel(model: string): EngineId | undefined {
  const id = model.toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('o1-') || id.startsWith('o3-')) {
    return 'openai';
  }
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-') || id.startsWith('gemma-')) return 'gemini';
  if (id.startsWith('sonar')) return 'perplexity';
  // Last resort: an id that is a current default but does not match a prefix.
  return ENGINE_ORDER.find((e) => DEFAULT_JUDGE_MODELS[e] === model);
}

/** The canonical set of engine ids, in a stable order. Single source of truth. */
export const ENGINE_ORDER: EngineId[] = [
  'openai',
  'anthropic',
  'gemini',
  'perplexity',
];

/** Engines whose API key is present and non-empty, in a stable order. */
export function detectAvailableEngines(
  env: Record<string, string | undefined>,
): EngineId[] {
  return ENGINE_ORDER.filter((engine) => {
    const value = env[ENGINE_KEY_ENV[engine]];
    return typeof value === 'string' && value.length > 0;
  });
}

/** User-resolvable config keys. All optional; resolution fills what it can. */
export interface OptifeedConfig {
  judgeModel?: string;
  engines?: EngineId[];
  maxCostUsd?: number;
  maxSetupCostUsd?: number;
}

/** Layers in ascending precedence: defaults < env < file < flags. */
export interface ConfigSources {
  defaults?: Partial<OptifeedConfig>;
  env?: Partial<OptifeedConfig>;
  file?: Partial<OptifeedConfig>;
  flags?: Partial<OptifeedConfig>;
}

/**
 * Merge config layers with precedence flags > file > env > defaults. A key that
 * is `undefined` in a higher layer does not clobber a lower layer's value.
 */
export function resolveConfig(sources: ConfigSources): OptifeedConfig {
  const layers = [sources.defaults, sources.env, sources.file, sources.flags];
  const out: OptifeedConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/** Raised when a judge model is needed but no engine keys are available. */
export class NoJudgeModelError extends Error {
  constructor() {
    super('No judge model available - no engine API keys are set');
    this.name = 'NoJudgeModelError';
  }
}

export interface ResolveJudgeModelInput {
  interactive: boolean;
  availableEngines: EngineId[];
  /** A previously saved explicit choice; wins when present. */
  savedJudgeModel?: string;
  /** Injected picker for the interactive path; receives candidate model ids. */
  prompt?: (choices: string[]) => Promise<string>;
}

export interface JudgeModelResolution {
  model: string;
  source: 'saved' | 'prompted' | 'fallback';
  /** Human-readable note when we fell back without asking (CI/MCP/--yes). */
  notice?: string;
  /**
   * Set when the resolved judge has a MEASURED quality problem, whatever the
   * selection path. Consumers must surface this - it reports that the run's
   * competitor list may be fabricated (rule #6).
   */
  qualityWarning?: string;
}

/**
 * Judge models in order of MEASURED competitor-recall quality, best first.
 *
 * This deliberately replaces the old "cheapest available" rule. The judge does
 * factual RECALL, and that rule kept silently downgrading it: first to
 * `claude-haiku-4-5`, then - once anthropic's default was corrected - to
 * `gemini-flash-latest`, because each new cheap entry undercut the measured
 * choice. Fixing each instance never fixed the rule.
 *
 * Measured 2026-07-20 on the doremusic Turkish-retailer task (ground truth
 * verified on the web, 3 trials each through the real discovery path):
 *
 * | model               | verified rivals | cross-trial stability |
 * | ------------------- | --------------- | --------------------- |
 * | gpt-5.4             | 4/4             | high                  |
 * | gemini-flash-latest | 4/4             | high                  |
 * | claude-sonnet-5     | 0               | none (no overlap)     |
 *
 * Price proved ANTI-correlated with quality: `claude-sonnet-5` is the most
 * expensive candidate ($3/$15) and the only one that fabricated, inventing a
 * different plausible-sounding list on every run and never returning Zuhal
 * Müzik, the market leader both other models ranked first every time.
 *
 * gpt-5.4 leads gemini-flash-latest on track record (measured twice, and no
 * free-tier rate-limit history) rather than on recall, where they tied.
 * `sonar` is last: it bills per search, so it is expensive AND a poor fit for
 * a parametric recall task.
 *
 * Re-measure when a default here changes - a model id is not a quality claim.
 */
export const JUDGE_PREFERENCE: string[] = [
  'gpt-5.4',
  'gemini-flash-latest',
  'claude-sonnet-5',
  'sonar',
];

/**
 * Judges with a measured quality problem, keyed by model id.
 *
 * Surfaced whenever the model is resolved - including when the user pinned it
 * explicitly - because rule #6 forbids running a known-unreliable judge
 * silently. The run still proceeds: an Anthropic-only user must keep a working
 * zero-config path.
 */
export const JUDGE_QUALITY_WARNINGS: Record<string, string> = {
  'claude-sonnet-5':
    'Judge quality: claude-sonnet-5 measured poorly on competitor recall (2026-07-20, Turkish retailer, 3 trials: 0 verifiable rivals and no overlap between its own runs). Competitor lists from this judge may be invented. Prefer --judge gpt-5.4 or gemini-flash-latest if you have that key.',
};

/** Judge-call cost for a model. Tie-breaks judges not yet ranked by recall. */
function judgeCallCost(model: string): number {
  const pricing = MODEL_PRICING.models[model];
  if (!pricing) return Number.POSITIVE_INFINITY;
  return costOfCall(
    pricing,
    ESTIMATE_ASSUMPTIONS.judgeInputTokens,
    ESTIMATE_ASSUMPTIONS.judgeOutputTokens,
  );
}

/**
 * Rank two judge candidates: measured recall first, then price.
 *
 * An unranked model (a new default nobody has measured) sorts after every
 * ranked one and falls back to the cheapest-wins tie-break, so adding an
 * engine degrades to the old behavior for that engine only, never for a
 * candidate we have evidence about.
 */
function judgeRank(model: string): number {
  const index = JUDGE_PREFERENCE.indexOf(model);
  return index === -1 ? JUDGE_PREFERENCE.length : index;
}

/**
 * Resolve which judge model to use. Order: saved explicit choice → interactive
 * prompt → best available by measured recall (non-interactive fallback, with a
 * printed notice). Throws {@link NoJudgeModelError} when no engines are
 * available.
 */
export async function resolveJudgeModel(
  input: ResolveJudgeModelInput,
): Promise<JudgeModelResolution> {
  const withWarning = (
    resolution: JudgeModelResolution,
  ): JudgeModelResolution => {
    const qualityWarning = JUDGE_QUALITY_WARNINGS[resolution.model];
    return qualityWarning ? { ...resolution, qualityWarning } : resolution;
  };

  if (input.savedJudgeModel) {
    return withWarning({ model: input.savedJudgeModel, source: 'saved' });
  }

  const candidates = input.availableEngines.map(
    (engine) => DEFAULT_JUDGE_MODELS[engine],
  );
  if (candidates.length === 0) throw new NoJudgeModelError();

  if (input.interactive && input.prompt) {
    const model = await input.prompt(candidates);
    return withWarning({ model, source: 'prompted' });
  }

  const best = candidates.reduce((winner, model) => {
    const rankDelta = judgeRank(model) - judgeRank(winner);
    if (rankDelta !== 0) return rankDelta < 0 ? model : winner;
    return judgeCallCost(model) < judgeCallCost(winner) ? model : winner;
  });
  return withWarning({
    model: best,
    source: 'fallback',
    notice: `No judge model chosen; using the best available judge (${best}). Set one with --judge or in optifeed.yml.`,
  });
}

export interface ResolveStateDirInput {
  cwd: string;
  domain: string;
  homeDir: string;
  /** Whether `<cwd>/.optifeed` can be created/written (injected fs check). */
  isProjectWritable: boolean;
}

/**
 * State dir: `<cwd>/.optifeed/<domain>` when the project dir is writable, else
 * `<home>/.optifeed/<domain>`. Domain-scoped in both cases so several brands
 * can be checked from one directory without their caches colliding. Uses
 * POSIX-style joins (no fs access).
 */
export function resolveStateDir(input: ResolveStateDirInput): string {
  const join = (...parts: string[]) => parts.join('/');
  return input.isProjectWritable
    ? join(input.cwd, '.optifeed', input.domain)
    : join(input.homeDir, '.optifeed', input.domain);
}
