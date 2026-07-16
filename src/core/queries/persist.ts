/**
 * Read/write/validate `queries.yml` (M5). All fs access is injected so unit
 * tests run with no disk (hard rule #3). YAML is the shareable, hand-editable
 * on-disk format; `toYaml` doubles as the `export` helper.
 */
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Query, QueryPack } from '../types.js';
import { createValidator, SchemaVersionError } from '../validation.js';
import { QUERY_INTENTS } from './generate.js';

/** The minimal fs surface query persistence needs, injectable for tests. */
export interface QueryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Thrown when a queries file is present but not a valid {@link QueryPack}. */
export class QueryPackError extends Error {
  constructor(
    public readonly detail: string,
    public readonly source?: string,
  ) {
    super(`Invalid query pack${source ? ` at ${source}` : ''}: ${detail}`);
    this.name = 'QueryPackError';
  }
}

/** The canonical queries path inside a state directory. */
export function queriesPath(stateDir: string): string {
  return join(stateDir, 'queries.yml');
}

/** Serialize a pack to YAML (also the shareable `export` format). */
export function toYaml(pack: QueryPack): string {
  return stringify(pack);
}

const INTENTS = new Set<string>(QUERY_INTENTS);

/** Parse + validate a YAML query pack, throwing {@link QueryPackError} on any defect. */
export function parseQueryPack(text: string, source?: string): QueryPack {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new QueryPackError(
      err instanceof Error ? err.message : 'not valid YAML',
      source,
    );
  }
  const v = createValidator((why) => {
    throw new QueryPackError(why, source);
  });
  const obj = v.object(raw, 'query pack');
  v.schemaVersion(obj);
  v.string(obj, 'domain');
  v.array(obj, 'queries');

  const queries: Query[] = (obj.queries as unknown[]).map((q, i) => {
    if (!q || typeof q !== 'object') {
      throw new QueryPackError(`query ${i} is not a mapping`, source);
    }
    const row = q as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) {
      throw new QueryPackError(`query ${i} has no id`, source);
    }
    if (typeof row.intent !== 'string' || !INTENTS.has(row.intent)) {
      throw new QueryPackError(`query ${i} has invalid intent`, source);
    }
    if (typeof row.prompt !== 'string' || !row.prompt.trim()) {
      throw new QueryPackError(`query ${i} has empty prompt`, source);
    }
    return {
      id: row.id,
      intent: row.intent as Query['intent'],
      prompt: row.prompt,
    };
  });

  return {
    schema_version: obj.schema_version as string,
    domain: obj.domain as string,
    queries,
    ...(typeof obj.generatedAt === 'string'
      ? { generatedAt: obj.generatedAt }
      : {}),
  };
}

/** Node fs.promises adapter for production use. */
export function nodeQueryFs(): QueryFs {
  return {
    async readFile(path) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
    async writeFile(path, data) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, data, 'utf8');
    },
    async mkdir(path) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path, { recursive: true });
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Load + validate the state-dir queries pack, or `null` if none exists. */
export async function loadQueryPack(
  stateDir: string,
  fs: QueryFs,
): Promise<QueryPack | null> {
  const path = queriesPath(stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    return parseQueryPack(raw, path);
  } catch (err) {
    // A stale-version cache is rebuildable: treat it as absent so the caller
    // regenerates instead of aborting. A malformed pack still throws
    // QueryPackError; an explicit --queries file (loadQueryPackFromFile) does
    // NOT recover - a user-supplied file surfaces its version mismatch.
    if (err instanceof SchemaVersionError) return null;
    throw err;
  }
}

/** Load + validate an explicit `--queries <file>` pack (must exist). */
export async function loadQueryPackFromFile(
  path: string,
  fs: QueryFs,
): Promise<QueryPack> {
  const raw = await fs.readFile(path);
  return parseQueryPack(raw, path);
}

/** Persist a pack as YAML, ensuring the state directory exists. */
export async function saveQueryPack(
  pack: QueryPack,
  stateDir: string,
  fs: QueryFs,
): Promise<string> {
  await fs.mkdir(stateDir);
  const path = queriesPath(stateDir);
  await fs.writeFile(path, toYaml(pack));
  return path;
}
