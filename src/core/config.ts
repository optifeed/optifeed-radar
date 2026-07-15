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

/** Default judge model per engine (cheapest sensible option for that provider). */
export const DEFAULT_JUDGE_MODELS: Record<EngineId, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
  perplexity: 'sonar',
};

const ENGINE_ORDER: EngineId[] = [
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
}

/** Judge-call cost for a model, used to pick the cheapest fallback. */
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
 * Resolve which judge model to use. Order: saved explicit choice → interactive
 * prompt → cheapest available (non-interactive fallback, with a printed notice).
 * Throws {@link NoJudgeModelError} when no engines are available.
 */
export async function resolveJudgeModel(
  input: ResolveJudgeModelInput,
): Promise<JudgeModelResolution> {
  if (input.savedJudgeModel) {
    return { model: input.savedJudgeModel, source: 'saved' };
  }

  const candidates = input.availableEngines.map(
    (engine) => DEFAULT_JUDGE_MODELS[engine],
  );
  if (candidates.length === 0) throw new NoJudgeModelError();

  if (input.interactive && input.prompt) {
    const model = await input.prompt(candidates);
    return { model, source: 'prompted' };
  }

  const cheapest = candidates.reduce((best, model) =>
    judgeCallCost(model) < judgeCallCost(best) ? model : best,
  );
  return {
    model: cheapest,
    source: 'fallback',
    notice: `No judge model chosen; defaulting to the cheapest available (${cheapest}). Set one with --judge or in optifeed.yml.`,
  };
}

export interface ResolveStateDirInput {
  cwd: string;
  domain: string;
  homeDir: string;
  /** Whether `<cwd>/.optifeed` can be created/written (injected fs check). */
  isProjectWritable: boolean;
}

/**
 * State dir: `<cwd>/.optifeed` when the project dir is writable, else
 * `<home>/.optifeed/<domain>`. Uses POSIX-style joins (no fs access).
 */
export function resolveStateDir(input: ResolveStateDirInput): string {
  const join = (...parts: string[]) => parts.join('/');
  return input.isProjectWritable
    ? join(input.cwd, '.optifeed')
    : join(input.homeDir, '.optifeed', input.domain);
}
