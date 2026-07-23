import { describe, expect, it } from 'vitest';
import {
  extractJsonBlocks,
  findMessagingViolations,
} from './messaging-rules.js';

describe('findMessagingViolations', () => {
  it('flags an em-dash', () => {
    const v = findMessagingViolations('Optifeed Radar - fast — honest', {});
    expect(v.some((m) => m.includes('em-dash'))).toBe(true);
  });

  it('flags an en-dash', () => {
    const v = findMessagingViolations('Optifeed Radar - fast – honest', {});
    expect(v.some((m) => m.includes('en-dash'))).toBe(true);
  });

  it('flags the OptiFeed mis-casing but not correct Optifeed', () => {
    expect(
      findMessagingViolations('OptiFeed Radar', {}).some((m) =>
        m.includes('OptiFeed'),
      ),
    ).toBe(true);
    expect(findMessagingViolations('Optifeed Radar', {})).toHaveLength(0);
  });

  // The product was renamed at M16 (package and product both). METHODOLOGY.md
  // still carried the old name a release later, because it was not linted -
  // the rule and the surface list both had gaps.
  it('flags the pre-rename product name', () => {
    for (const stale of [
      'the score Optifeed Visibility reports',
      'install optifeed-visibility from npm',
    ]) {
      const v = findMessagingViolations(stale, {});
      expect(v.some((m) => m.includes('renamed'))).toBe(true);
    }
    expect(findMessagingViolations('Optifeed Radar reports', {})).toEqual([]);
  });

  it('flags free-vs-paid equivalence framing', () => {
    const v = findMessagingViolations('Get paid tools for free here', {});
    expect(v.some((m) => m.includes('free-vs-paid'))).toBe(true);
  });

  // Scope revision 2 (2026-07-18): Shopping-lite SHIPPED, so present tense is
  // now correct for the products a user names. What stays roadmap is
  // everything the tool does not do: finding products by itself, and linting
  // product feeds.
  it('accepts present-tense copy about the products a user names', () => {
    const ok = 'shopping checks the products you name, in your own order';
    expect(
      findMessagingViolations(ok, { enforceRoadmapGate: true }),
    ).toHaveLength(0);
  });

  it('flags a claim that it discovers products by itself', () => {
    for (const claim of [
      'Optifeed Radar scans your catalog',
      'it reads your product feed automatically',
      'Shopping imports your Shopify products',
    ]) {
      const v = findMessagingViolations(claim, { enforceRoadmapGate: true });
      expect(v.some((m) => m.includes('discovery'))).toBe(true);
    }
  });

  it('flags a present-tense feed-linting claim', () => {
    const v = findMessagingViolations('Optifeed Radar lints your feed', {
      enforceRoadmapGate: true,
    });
    expect(v.some((m) => m.includes('roadmap'))).toBe(true);
  });

  it('requires a waitlist when roadmap work is named', () => {
    const v = findMessagingViolations(
      'Catalog discovery and feed linting are coming later',
      { enforceRoadmapGate: true },
    );
    expect(v.some((m) => m.includes('waitlist'))).toBe(true);
  });

  it('passes clean roadmap copy that gates on a waitlist', () => {
    const ok =
      'Catalog discovery and feed linting will arrive later - join the waitlist at optifeed.com';
    expect(
      findMessagingViolations(ok, { enforceRoadmapGate: true }),
    ).toHaveLength(0);
  });

  it('requires the footer CTA when asked', () => {
    expect(
      findMessagingViolations('no cta here', { requireFooter: true }).some(
        (m) => m.includes('footer'),
      ),
    ).toBe(true);
    expect(
      findMessagingViolations('ends with More at optifeed.com', {
        requireFooter: true,
      }),
    ).toHaveLength(0);
  });
});

describe('extractJsonBlocks', () => {
  it('pulls fenced json blocks and ignores bash blocks', () => {
    const md = [
      '```bash',
      'npm install',
      '```',
      '```json',
      '{ "a": 1 }',
      '```',
    ].join('\n');
    const blocks = extractJsonBlocks(md);
    expect(blocks).toHaveLength(1);
    const [first] = blocks;
    expect(JSON.parse(first ?? '')).toEqual({ a: 1 });
  });
});

describe('speed claims about check', () => {
  it('flags "results in seconds" - a check takes about a minute', () => {
    const v = findMessagingViolations(
      'Get your visibility results in seconds',
      {},
    );
    expect(v.some((m) => m.includes('speed'))).toBe(true);
  });

  it('flags "instant results"', () => {
    const v = findMessagingViolations('Instant results from four engines', {});
    expect(v.some((m) => m.includes('speed'))).toBe(true);
  });

  it('leaves a measured statement alone', () => {
    // The audit really is seconds; the rule targets the unqualified claim.
    expect(
      findMessagingViolations(
        'audit finishes in about 2 seconds (measured)',
        {},
      ),
    ).toHaveLength(0);
  });
});
