import { describe, it, expect } from 'vitest';
import { defaultToolContext, DEFAULT_MCP_MAX_COST } from './deps.js';
import { createFetcher } from '../core/fetcher/index.js';

describe('defaultToolContext', () => {
  const env = { OPENAI_API_KEY: 'sk-test' } as Record<
    string,
    string | undefined
  >;
  const ctx = defaultToolContext({
    env,
    cwd: '/proj',
    homeDir: '/home/u',
    isProjectWritable: false,
    fetcher: createFetcher(),
  });

  it('reports the available engines from the env', () => {
    expect(ctx.availableEngines()).toContain('openai');
  });

  it('scopes the state dir per domain', () => {
    const a = ctx.resolveStateDir('acme.example');
    const b = ctx.resolveStateDir('other.example');
    expect(a).not.toBe(b);
    expect(a).toContain('acme.example');
  });

  it('applies the default MCP cost cap when the agent passes no max_cost', async () => {
    const deps = await ctx.checkDeps({ availableEngines: ['openai'] });
    expect(DEFAULT_MCP_MAX_COST).toBeCloseTo(0.5);
    expect(deps.guard).toBeDefined();
  });
});
