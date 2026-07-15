import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JUDGE_MODELS,
  NoJudgeModelError,
  detectAvailableEngines,
  resolveConfig,
  resolveJudgeModel,
  resolveStateDir,
} from './config.js';

describe('detectAvailableEngines', () => {
  it('lists engines whose API key env var is present and non-empty', () => {
    const engines = detectAvailableEngines({
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: 'g',
      // PERPLEXITY_API_KEY absent
    });
    expect(engines).toEqual(['openai', 'gemini']);
  });

  it('returns [] when no keys are set', () => {
    expect(detectAvailableEngines({})).toEqual([]);
  });
});

describe('resolveConfig precedence (flags > file > env > defaults)', () => {
  it('takes each key from the highest-precedence layer that defines it', () => {
    const cfg = resolveConfig({
      defaults: { judgeModel: 'default-m', maxCostUsd: 1 },
      env: { judgeModel: 'env-m', maxSetupCostUsd: 0.05 },
      file: { judgeModel: 'file-m' },
      flags: { maxCostUsd: 5 },
    });
    expect(cfg.judgeModel).toBe('file-m'); // file beats env beats default
    expect(cfg.maxCostUsd).toBe(5); // flags beat default
    expect(cfg.maxSetupCostUsd).toBe(0.05); // only env defined it
  });

  it('does not let an undefined higher layer clobber a lower one', () => {
    const cfg = resolveConfig({
      defaults: { judgeModel: 'default-m' },
      flags: { judgeModel: undefined },
    });
    expect(cfg.judgeModel).toBe('default-m');
  });
});

describe('resolveJudgeModel fallback matrix', () => {
  it('uses the saved choice when set, regardless of interactivity', async () => {
    const res = await resolveJudgeModel({
      interactive: true,
      savedJudgeModel: 'gpt-4o',
      availableEngines: ['openai', 'anthropic'],
    });
    expect(res).toMatchObject({ model: 'gpt-4o', source: 'saved' });
  });

  it('prompts when interactive and unset', async () => {
    const prompt = vi.fn(async (choices: string[]) => choices[1]!);
    const res = await resolveJudgeModel({
      interactive: true,
      availableEngines: ['openai', 'anthropic'],
      prompt,
    });
    expect(prompt).toHaveBeenCalledWith([
      DEFAULT_JUDGE_MODELS.openai,
      DEFAULT_JUDGE_MODELS.anthropic,
    ]);
    expect(res).toMatchObject({
      model: DEFAULT_JUDGE_MODELS.anthropic,
      source: 'prompted',
    });
  });

  it('falls back to the cheapest available model non-interactively, with a notice', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['anthropic', 'openai'], // openai (gpt-4o-mini) is cheapest
    });
    expect(res.source).toBe('fallback');
    expect(res.model).toBe(DEFAULT_JUDGE_MODELS.openai);
    expect(res.notice).toBeTruthy();
  });

  it('throws when no engines are available', async () => {
    await expect(
      resolveJudgeModel({ interactive: false, availableEngines: [] }),
    ).rejects.toBeInstanceOf(NoJudgeModelError);
  });
});

describe('resolveStateDir', () => {
  it('uses ./.optifeed/<domain> when the project dir is writable', () => {
    const dir = resolveStateDir({
      cwd: '/home/u/project',
      domain: 'acme.com',
      homeDir: '/home/u',
      isProjectWritable: true,
    });
    // Domain-scoped so multiple brands can be checked from one directory
    // without their caches colliding.
    expect(dir).toBe('/home/u/project/.optifeed/acme.com');
  });

  it('falls back to ~/.optifeed/<domain> when the project dir is not writable', () => {
    const dir = resolveStateDir({
      cwd: '/readonly',
      domain: 'acme.com',
      homeDir: '/home/u',
      isProjectWritable: false,
    });
    expect(dir).toBe('/home/u/.optifeed/acme.com');
  });
});
