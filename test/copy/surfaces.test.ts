import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractJsonBlocks,
  findMessagingViolations,
  type MessagingRuleOptions,
} from './messaging-rules.js';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

// Every human-readable surface carries roadmap copy, so all get the roadmap
// gate (not just the README) - a future present-tense "Shopping" claim on any
// of them must fail the lint. plugin.json is a config manifest (no prose,
// no footer), so it only gets the always-on banned-substring checks.
const humanCopy: MessagingRuleOptions = {
  enforceRoadmapGate: true,
  requireFooter: true,
};

const SURFACES: { file: string; opts: MessagingRuleOptions }[] = [
  { file: 'README.md', opts: humanCopy },
  { file: 'skills/optifeed-radar/SKILL.md', opts: humanCopy },
  { file: 'ai-context/claude-project.md', opts: humanCopy },
  { file: 'ai-context/chatgpt-custom-gpt.md', opts: humanCopy },
  { file: 'ai-context/cursor.mdc', opts: humanCopy },
  { file: 'ai-context/windsurf.md', opts: humanCopy },
  { file: '.claude-plugin/plugin.json', opts: {} },
];

describe('surface copy passes the messaging lint', () => {
  for (const { file, opts } of SURFACES) {
    it(`${file} has no messaging violations`, () => {
      expect(findMessagingViolations(read(file), opts)).toEqual([]);
    });
  }
});

describe('README config blocks are valid JSON', () => {
  it('every json block parses', () => {
    const blocks = extractJsonBlocks(read('README.md'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });
});
