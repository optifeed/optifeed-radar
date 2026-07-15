import { describe, expect, it } from 'vitest';
import { AI_BOTS, botAccessTable } from './robots.js';

function access(table: ReturnType<typeof botAccessTable>, bot: string) {
  return table.find((row) => row.bot === bot);
}

describe('botAccessTable', () => {
  it('covers exactly the checked-in AI bot list', () => {
    const table = botAccessTable('');
    expect(table.map((r) => r.bot).sort()).toEqual(
      AI_BOTS.map((b) => b.id).sort(),
    );
  });

  it('treats a missing robots.txt as all-allowed by default', () => {
    const table = botAccessTable(null);
    expect(table.every((r) => r.access === 'allowed')).toBe(true);
    expect(access(table, 'GPTBot')?.via).toBe('default');
  });

  it('marks a specifically disallowed bot as blocked while others stay allowed', () => {
    const table = botAccessTable('User-agent: GPTBot\nDisallow: /');
    expect(access(table, 'GPTBot')).toMatchObject({
      access: 'blocked',
      via: 'specific',
    });
    expect(access(table, 'ClaudeBot')?.access).toBe('allowed');
  });

  it('applies a wildcard block to every bot', () => {
    const table = botAccessTable('User-agent: *\nDisallow: /');
    expect(table.every((r) => r.access === 'blocked')).toBe(true);
    expect(access(table, 'PerplexityBot')?.via).toBe('wildcard');
  });

  it('lets a specific Allow: / override Disallow: /', () => {
    const table = botAccessTable('User-agent: GPTBot\nDisallow: /\nAllow: /');
    expect(access(table, 'GPTBot')?.access).toBe('allowed');
  });

  it('prefers a specific group over the wildcard group', () => {
    const robots =
      'User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow:\n';
    const table = botAccessTable(robots);
    expect(access(table, 'GPTBot')).toMatchObject({
      access: 'allowed',
      via: 'specific',
    });
    expect(access(table, 'CCBot')?.access).toBe('blocked');
  });

  it('ignores comments and is case-insensitive on the user-agent token', () => {
    const table = botAccessTable(
      '# block the crawler\nuser-agent: gptbot\ndisallow: /',
    );
    expect(access(table, 'GPTBot')?.access).toBe('blocked');
  });
});
