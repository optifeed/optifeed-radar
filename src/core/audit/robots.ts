/**
 * robots.txt parsing and the AI-crawler access table (M3).
 *
 * The bot list is a checked-in constant so new crawlers are one line to add.
 * Access is evaluated for the site root ("/") only - that is what determines
 * whether an AI crawler may read the site at all.
 */

/** The AI crawlers we report on. Extend by adding a row. */
export const AI_BOTS = [
  { id: 'GPTBot', vendor: 'OpenAI' },
  { id: 'OAI-SearchBot', vendor: 'OpenAI' },
  { id: 'ClaudeBot', vendor: 'Anthropic' },
  { id: 'anthropic-ai', vendor: 'Anthropic' },
  { id: 'PerplexityBot', vendor: 'Perplexity' },
  { id: 'Google-Extended', vendor: 'Google' },
  { id: 'GoogleOther', vendor: 'Google' },
  { id: 'CCBot', vendor: 'Common Crawl' },
  { id: 'meta-externalagent', vendor: 'Meta' },
] as const;

export type BotAccessStatus = 'allowed' | 'blocked';
export type BotAccessVia = 'specific' | 'wildcard' | 'default';

export interface BotAccess {
  bot: string;
  vendor: string;
  access: BotAccessStatus;
  via: BotAccessVia;
}

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

/** Parse robots.txt into user-agent groups (comments/blank lines ignored). */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!current || !lastLineWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
  }

  return groups;
}

function groupForAgent(
  groups: RobotsGroup[],
  bot: string,
): { group: RobotsGroup; via: BotAccessVia } | undefined {
  const needle = bot.toLowerCase();
  const specific = groups.find((g) => g.agents.includes(needle));
  if (specific) return { group: specific, via: 'specific' };
  const wildcard = groups.find((g) => g.agents.includes('*'));
  if (wildcard) return { group: wildcard, via: 'wildcard' };
  return undefined;
}

/** True when the group blocks the site root without an overriding Allow: /. */
function blocksRoot(group: RobotsGroup): boolean {
  const disallowsRoot = group.disallow.includes('/');
  const allowsRoot = group.allow.includes('/');
  return disallowsRoot && !allowsRoot;
}

/**
 * Per-bot access to the site root. A null/absent robots.txt means everything is
 * allowed by default.
 */
export function botAccessTable(robotsTxt: string | null): BotAccess[] {
  const groups = robotsTxt ? parseRobots(robotsTxt) : [];
  return AI_BOTS.map(({ id, vendor }) => {
    const match = groupForAgent(groups, id);
    if (!match) {
      return { bot: id, vendor, access: 'allowed', via: 'default' };
    }
    return {
      bot: id,
      vendor,
      access: blocksRoot(match.group) ? 'blocked' : 'allowed',
      via: match.via,
    };
  });
}
