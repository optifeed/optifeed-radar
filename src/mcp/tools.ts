/**
 * The 4 launch-#1 MCP tools. Each is a THIN adapter over `core/run` + a
 * `core/output` JSON renderer - no pipeline logic here (hard rule #1). Tool
 * descriptions are written FOR agents: a when-to-use line and a cost hint.
 * `compare_competitors`, `shopping_check`, `lint_feed` are launch #2.
 */
import {
  runAudit,
  runCheck,
  runGenerateQueries,
  type ProgressEvent,
} from '../core/run/index.js';
import {
  renderCheckJson,
  renderAuditJson,
  renderDiffJson,
  listSnapshots,
  loadSnapshot,
  diffEnvelopes,
} from '../core/output/index.js';
import type { ToolContext } from './deps.js';
import { SCHEMA_VERSION, type EngineId } from '../core/types.js';

/** A JSON-Schema tool definition, snapshot-tested in server.test.ts. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool-call result shape (subset we produce). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

const ENGINE_ENUM: EngineId[] = ['openai', 'anthropic', 'gemini', 'perplexity'];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'check_visibility',
    description:
      'Ask real AI engines real buyer questions and score whether this brand ' +
      'gets recommended. Use when you want the AI Visibility Score for a domain. ' +
      'COST: spends real API money (roughly $0.05-$0.30/run depending on engines ' +
      'and prompt count); capped at $0.50 by default - pass max_cost to change it.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand site, e.g. example.com',
        },
        engines: {
          type: 'array',
          items: { type: 'string', enum: ENGINE_ENUM },
          description: 'Engines to query; defaults to all with keys present',
        },
        quick: {
          type: 'boolean',
          description: 'Use a smaller 8-prompt pack (cheaper, faster)',
        },
        max_cost: {
          type: 'number',
          description: 'Hard cap on total spend in USD (default 0.50)',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'audit_store',
    description:
      'Zero-key, zero-cost readiness audit: robots.txt AI-bot access, llms.txt, ' +
      'structured data, meta, sitemap. Use for a fast free check with no API keys. ' +
      'COST: free (no LLM calls).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand site, e.g. example.com',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'generate_buyer_queries',
    description:
      'Generate the buyer questions this brand should be visible for (discovers ' +
      'the brand profile first, then writes a query pack). Use to preview or seed ' +
      'the prompts before a paid check_visibility run. COST: a small number of ' +
      'judge calls for discovery + generation (typically under $0.05).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand site, e.g. example.com',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_snapshot_diff',
    description:
      'Compare the two most recent check_visibility runs for a domain (score and ' +
      'per-engine deltas). Use to see what changed between runs. COST: free (reads ' +
      'saved snapshots).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand site, e.g. example.com',
        },
      },
      required: ['domain'],
    },
  },
];

function ok(text: string, structured: unknown): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Dispatch a tool call. `args` is the raw MCP arguments object. */
export async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  onProgress?: (fraction: number, message: string) => void,
): Promise<ToolResult> {
  const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
  if (!domain) return err('A non-empty "domain" argument is required.');
  // `domain` flows into a filesystem path (resolveStateDir joins it raw). MCP is
  // the non-interactive, agent-relayed surface (no human keystroke in front of
  // it), so reject anything that is not a plain hostname before it can traverse
  // out of the state dir - path separators, `..`, whitespace, control chars.
  if (!isPlausibleDomain(domain)) {
    return err(
      `"${domain}" is not a valid domain. Pass a bare hostname like example.com.`,
    );
  }

  try {
    switch (name) {
      case 'audit_store': {
        const report = await runAudit(domain, { fetcher: ctx.fetcher });
        return ok(renderAuditJson(report), report);
      }

      case 'check_visibility': {
        const available = ctx.availableEngines();
        if (available.length === 0) {
          return err(
            'check_visibility needs at least one engine API key ' +
              '(OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, PERPLEXITY_API_KEY). ' +
              `For a free, zero-key readiness check use audit_store on ${domain}.`,
          );
        }
        const parsed = parseEngines(args.engines);
        if (parsed.kind === 'empty') {
          // An `engines` array whose values are ALL unrecognized must NOT fall
          // through to "query every available engine" (that would bill for
          // engines the caller never asked for). Reject before spending, the
          // way the CLI rejects an unrecognized --engines list.
          return err(
            `No recognized engines in "engines". Known engines: ${ENGINE_ENUM.join(', ')}.`,
          );
        }
        const engines = parsed.kind === 'engines' ? parsed.engines : undefined;
        const wantAvailable = engines
          ? available.filter((e) => engines.includes(e))
          : available;
        if (engines && wantAvailable.length === 0) {
          return err(
            `None of the requested engines have keys. Available: ${available.join(', ')}.`,
          );
        }
        const deps = await ctx.checkDeps({
          engines,
          maxCost:
            typeof args.max_cost === 'number' ? args.max_cost : undefined,
          availableEngines: wantAvailable,
        });
        if (onProgress) {
          deps.onProgress = (e): void => {
            const { fraction, message } = progressFor(e);
            onProgress(fraction, message);
          };
        }
        const result = await runCheck(domain, deps, {
          stateDir: ctx.resolveStateDir(domain),
          yes: true, // non-interactive (hard rule #8)
          count: args.quick === true ? 8 : undefined,
        });
        if (!result.envelope) {
          return err(
            `check_visibility did not produce a result: ${result.notes.join('; ') || 'aborted'}.`,
          );
        }
        const json = renderCheckJson(result.envelope);
        const note = result.snapshotPath
          ? `\n\nSnapshot saved at ${result.snapshotPath}`
          : '';
        return ok(json + note, result.envelope);
      }

      case 'generate_buyer_queries': {
        if (ctx.availableEngines().length === 0) {
          return err(
            'generate_buyer_queries needs at least one engine API key to run the ' +
              'discovery + generation judge calls (OPENAI_API_KEY, ANTHROPIC_API_KEY, ' +
              `GOOGLE_API_KEY, PERPLEXITY_API_KEY). For a free check use audit_store on ${domain}.`,
          );
        }
        const result = await runGenerateQueries(domain, await ctx.queryDeps(), {
          stateDir: ctx.resolveStateDir(domain),
        });
        const payload = {
          ...result.pack,
          notes: result.notes,
          ...(result.costCapped ? { costCapped: true } : {}),
          ...(result.path ? { savedAt: result.path } : {}),
        };
        return ok(JSON.stringify(payload, null, 2), payload);
      }

      case 'get_snapshot_diff': {
        const stateDir = ctx.resolveStateDir(domain);
        const paths = await listSnapshots(stateDir, ctx.snapshotFs);
        if (paths.length < 2) {
          const payload = {
            schema_version: SCHEMA_VERSION,
            domain,
            note: `Need at least 2 saved runs to diff; found ${paths.length}. Run check_visibility on ${domain} at least twice.`,
            snapshots: paths.length,
          };
          return ok(JSON.stringify(payload, null, 2), payload);
        }
        // listSnapshots is chronological (oldest first): last two are newest.
        const [baseline, latest] = await Promise.all([
          loadSnapshot(paths[paths.length - 2]!, ctx.snapshotFs),
          loadSnapshot(paths[paths.length - 1]!, ctx.snapshotFs),
        ]);
        const diff = diffEnvelopes(baseline, latest);
        return ok(renderDiffJson(diff), diff);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    // Graceful failure (rule #5): a thrown core error becomes an honest tool
    // error, never a server crash or an unhandled rejection.
    return err(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Result of interpreting the raw `engines` argument. Three distinct cases so
 * the handler never confuses "no filter requested" with "filter requested but
 * nothing recognized" (the latter must abort, not silently query everything).
 */
type ParsedEngines =
  | { kind: 'none' } // no `engines` array supplied -> use all available
  | { kind: 'engines'; engines: EngineId[] } // >=1 recognized engine
  | { kind: 'empty' }; // an array was given but zero values were recognized

function parseEngines(raw: unknown): ParsedEngines {
  if (!Array.isArray(raw)) return { kind: 'none' };
  const ids = raw.filter((e): e is EngineId =>
    ENGINE_ENUM.includes(e as EngineId),
  );
  return ids.length ? { kind: 'engines', engines: ids } : { kind: 'empty' };
}

/**
 * Conservative hostname check. `domain` is concatenated into the on-disk state
 * path, and MCP is a non-interactive surface, so only allow letters, digits,
 * dots, and hyphens - and never a `..` sequence (path traversal). This is a
 * safety gate, not a strict RFC validator: it rejects `/`, `\`, whitespace,
 * control chars, and `../` while accepting normal hosts and subdomains.
 */
function isPlausibleDomain(domain: string): boolean {
  return (
    domain.length <= 253 &&
    /^[A-Za-z0-9.-]+$/.test(domain) &&
    !domain.includes('..') &&
    !domain.startsWith('.') &&
    !domain.startsWith('-')
  );
}

/**
 * Map a run {@link ProgressEvent} to a monotonically increasing fraction in
 * [0,1] and a human-readable message. Phases get coarse bands; the per-answer
 * ask events scale their real `done`/`total` counts into the 0.4-0.9 band. The
 * terminal 1.0 is reported by the caller when the tool result is returned, not
 * from any single event.
 */
function progressFor(event: ProgressEvent): {
  fraction: number;
  message: string;
} {
  switch (event.kind) {
    case 'discovery-start':
      return { fraction: 0.05, message: 'discovering the brand' };
    case 'discovery-done':
      return { fraction: 0.1, message: `discovered ${event.brand}` };
    case 'queries-start':
      return { fraction: 0.15, message: 'generating buyer queries' };
    case 'queries-done':
      return {
        fraction: 0.3,
        message: `${event.prompts.length} buyer queries ready`,
      };
    case 'ask-start':
      return { fraction: 0.4, message: `asking ${event.total} prompts` };
    case 'ask-answered': {
      const ratio = event.total > 0 ? event.done / event.total : 0;
      return {
        fraction: 0.4 + 0.5 * ratio,
        message: `asking: ${event.done}/${event.total} answered`,
      };
    }
    case 'ask-done':
      return {
        fraction: 0.9,
        message: `asked ${event.answered}/${event.total}`,
      };
    case 'scoring-start':
      return { fraction: 0.92, message: 'scoring answers' };
    case 'scoring-done':
      return { fraction: 0.95, message: 'scoring done' };
  }
}
