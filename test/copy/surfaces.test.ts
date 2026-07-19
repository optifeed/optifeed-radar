import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractJsonBlocks,
  findMessagingViolations,
  type MessagingRuleOptions,
} from './messaging-rules.js';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

const SURFACES: { file: string; opts: MessagingRuleOptions }[] = [
  {
    file: 'README.md',
    opts: { enforceRoadmapGate: true, requireFooter: true },
  },
  { file: 'skills/optifeed-radar/SKILL.md', opts: { requireFooter: true } },
  { file: 'ai-context/claude-project.md', opts: { requireFooter: true } },
  { file: 'ai-context/chatgpt-custom-gpt.md', opts: { requireFooter: true } },
  { file: 'ai-context/cursor.mdc', opts: { requireFooter: true } },
  { file: 'ai-context/windsurf.md', opts: { requireFooter: true } },
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
