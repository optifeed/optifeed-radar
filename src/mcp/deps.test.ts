import { describe, it, expect } from 'vitest';
import {
  defaultToolContext,
  DEFAULT_MCP_MAX_COST,
  DEFAULT_MCP_SHOPPING_PER_PRODUCT_USD,
} from './deps.js';
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

  it('hands out a FRESH fetcher per tool invocation (no cross-call stale cache)', () => {
    // The default fetcher's cache is a permanent per-instance Map (built for one
    // CLI run). Reusing one instance across a long-lived MCP session would serve
    // stale responses and grow unbounded, so each call must get its own.
    const live = defaultToolContext({
      env,
      cwd: '/proj',
      homeDir: '/home/u',
      isProjectWritable: false,
    });
    expect(live.newFetcher()).not.toBe(live.newFetcher());
  });

  it('reuses an injected fetcher (so tests can observe requests)', () => {
    const injected = createFetcher();
    const withInjected = defaultToolContext({
      env,
      cwd: '/proj',
      homeDir: '/home/u',
      isProjectWritable: false,
      fetcher: injected,
    });
    expect(withInjected.newFetcher()).toBe(injected);
  });
});

describe('shopping_check cost cap', () => {
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

  // A shopping run is much bigger than a check, so the flat check cap would
  // truncate most multi-product runs into a partial ranking. The cap scales
  // with the list instead, and an explicit max_cost always wins.
  it('scales the default cap with the number of products', async () => {
    const deps = await ctx.shoppingDeps({
      productCount: 4,
      availableEngines: ['openai'],
    });
    const guard = deps.guard!;
    expect(DEFAULT_MCP_SHOPPING_PER_PRODUCT_USD).toBeCloseTo(0.2);
    // 4 products x $0.20 = $0.80: authorized just under, refused just over.
    expect(guard.authorize(0.79)).toBe(true);
    expect(guard.authorize(0.02)).toBe(false);
  });

  it('lets an explicit max_cost win over the scaled default', async () => {
    const deps = await ctx.shoppingDeps({
      productCount: 10,
      maxCost: 0.1,
      availableEngines: ['openai'],
    });
    expect(deps.guard!.authorize(0.2)).toBe(false);
  });

  it('never builds a zero cap from an empty list', async () => {
    const deps = await ctx.shoppingDeps({
      productCount: 0,
      availableEngines: ['openai'],
    });
    expect(deps.guard!.authorize(0.05)).toBe(true);
  });
});
