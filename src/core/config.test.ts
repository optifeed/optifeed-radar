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

  // The judge is now ranked by MEASURED competitor recall, not by price. The
  // price rule kept finding new ways to downgrade the judge (haiku, then
  // gemini-flash) because the judge does factual RECALL, where cheap models
  // fabricate. Measured 2026-07-20 on the doremusic Turkish-retailer task with
  // web-verified ground truth, 3 trials each through the real discovery path:
  //   gpt-5.4              4/4 verified rivals, stable across trials
  //   gemini-flash-latest  4/4 verified rivals, stable across trials
  //   claude-sonnet-5      0 verified, ZERO overlap between its own 3 trials
  // Price turned out to be ANTI-correlated with quality: sonnet-5 is the most
  // expensive candidate ($3/$15) and the only one that fabricated.
  // Assertions name concrete ids, not DEFAULT_JUDGE_MODELS.*, so a future
  // default change cannot quietly re-satisfy them.
  it('prefers the measured judge over a cheaper one (gpt-5.4 beats gemini)', async () => {
    // gemini-flash-latest ($1.50/$9.00) undercuts gpt-5.4 ($2.50/$15.00), so
    // under the old price rule a Google key silently took the judge. Both
    // measured equally on recall; gpt-5.4 leads on track record.
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['openai', 'gemini'],
    });
    expect(res.source).toBe('fallback');
    expect(res.model).toBe('gpt-5.4');
    expect(res.notice).toBeTruthy();
    expect(res.notice).not.toMatch(/cheapest/i);
  });

  it('prefers a measured judge over a measured-poor one, ignoring price', async () => {
    // The sharpest case: gemini is CHEAPER than sonnet-5 and also better, so
    // price and quality agree here only by luck. What this pins is that the
    // ranking is the reason - sonnet-5 must never win on any axis.
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['anthropic', 'gemini'],
    });
    expect(res.model).toBe('gemini-flash-latest');
  });

  it('keeps gpt-5.4 over anthropic', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['anthropic', 'openai'],
    });
    expect(res.source).toBe('fallback');
    expect(res.model).toBe('gpt-5.4');
  });

  it('ranks sonar last - a search-billed model is a poor judge', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['perplexity', 'anthropic'],
    });
    expect(res.model).toBe('claude-sonnet-5');
  });

  it('picks the top preference when every engine is available', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['perplexity', 'gemini', 'anthropic', 'openai'],
    });
    expect(res.model).toBe('gpt-5.4');
  });

  it('picks the openai judge when it is the only engine available', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['openai'],
    });
    expect(res.model).toBe('gpt-5.4');
    expect(res.qualityWarning).toBeUndefined();
  });

  // Rule #6: a judge measured to fabricate must not be used silently. The run
  // still proceeds (zero-config must keep working for an Anthropic-only user),
  // but it says so.
  it('warns when the only available judge measured poorly', async () => {
    const res = await resolveJudgeModel({
      interactive: false,
      availableEngines: ['anthropic'],
    });
    expect(res.model).toBe('claude-sonnet-5');
    expect(res.qualityWarning).toMatch(/recall/i);
    expect(res.qualityWarning).toMatch(/--judge/);
  });

  it('warns about a measured-poor judge the user pinned explicitly', async () => {
    // The warning follows the MODEL, not the selection path - pinning a known
    // fabricator with --judge should not buy silence.
    const res = await resolveJudgeModel({
      interactive: true,
      savedJudgeModel: 'claude-sonnet-5',
      availableEngines: ['openai', 'anthropic'],
    });
    expect(res.source).toBe('saved');
    expect(res.qualityWarning).toMatch(/recall/i);
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
