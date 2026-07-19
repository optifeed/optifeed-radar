/**
 * Shared classification of a requested engine list, used by BOTH the CLI
 * (`--engines a,b`) and the MCP `check_visibility` tool. One home for the
 * "drop unknown tokens; an all-unknown selection must abort, not silently
 * query (and bill) every engine" policy, so the two surfaces can never diverge
 * (M15 review lesson). Each surface handles its own input SHAPE (a CSV string
 * vs. a JSON array) and maps the result onto its own error path.
 */
import { ENGINE_ORDER } from '../config.js';
import type { EngineId } from '../types.js';

export type EngineSelection =
  | { kind: 'none' } // no tokens -> caller uses all available engines
  | { kind: 'engines'; engines: EngineId[] } // >=1 recognized engine
  | { kind: 'empty' }; // tokens given, none recognized -> caller must abort

/** Classify raw engine tokens (trimmed/lowercased, blanks ignored). */
export function selectEngines(tokens: readonly string[]): EngineSelection {
  const normalized = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return { kind: 'none' };
  const ids = normalized.filter((e): e is EngineId =>
    (ENGINE_ORDER as string[]).includes(e),
  );
  return ids.length ? { kind: 'engines', engines: ids } : { kind: 'empty' };
}
