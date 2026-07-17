/**
 * Shared load-time validation for persisted artifacts (profile.json,
 * queries.yml, snapshots). Every loader that reads a hand-editable or on-disk
 * file must confirm its `schema_version` matches the supported one (hard rule
 * #2) and that every field a consumer later dereferences is present with the
 * right type - a loader that vouches for only some fields gives false
 * confidence (M8 review lesson #3).
 *
 * This helper is error-agnostic: each loader keeps its own error type
 * (`ProfileParseError`, `QueryPackError`, `SnapshotParseError`) by passing a
 * `fail` sink, so callers get a domain-specific error while the checks stay in
 * one place and cannot drift apart.
 */
import { SCHEMA_VERSION } from './types.js';

/**
 * Thrown when a persisted artifact's `schema_version` is present but not the
 * supported one. A DISTINCT type (not each loader's generic parse error) so a
 * caller can tell "incompatible version" from "corrupt/malformed" and choose to
 * recover: a rebuildable cache (profile/queries) treats it as absent and
 * rebuilds, while a historical snapshot or an explicit file lets it surface.
 */
export class SchemaVersionError extends Error {
  constructor(public readonly found: unknown) {
    super(
      `schema_version ${String(found)} is not supported (expected ${SCHEMA_VERSION})`,
    );
    this.name = 'SchemaVersionError';
  }
}

/** A record of parsed-but-unvalidated fields. */
export type Unvalidated = Record<string, unknown>;

/** Field-level assertions bound to a caller-supplied failure sink. */
export interface StructValidator {
  /** Assert `value` is a non-null, non-array object; return it as a record. */
  object(value: unknown, label?: string): Unvalidated;
  /** Assert `schema_version` is present AND equals the supported version (rule #2). */
  schemaVersion(obj: Unvalidated): void;
  /** Assert `obj[key]` is a string. */
  string(obj: Unvalidated, key: string): void;
  /** Assert `obj[key]` is a number. */
  number(obj: Unvalidated, key: string): void;
  /** Assert `obj[key]` is a number or `null` (an intentionally nullable field). */
  numberOrNull(obj: Unvalidated, key: string): void;
  /** Assert `obj[key]` is an array. */
  array(obj: Unvalidated, key: string): void;
  /** Assert `obj[key]` is a non-null, non-array object. */
  objectField(obj: Unvalidated, key: string): void;
}

function isPlainObject(v: unknown): v is Unvalidated {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A type-failure message that distinguishes an absent field ("missing X") from
 * one that is present but the wrong type ("X must be a string"), so a user
 * fixing a hand-edited file is not misdirected.
 */
function typed(obj: Unvalidated, key: string, expected: string): string {
  return obj[key] === undefined
    ? `missing ${key}`
    : `${key} must be ${expected}`;
}

/**
 * Build a {@link StructValidator} that reports every failure through `fail`.
 * `fail` must not return (it throws the caller's domain-specific error), which
 * lets the assertions narrow types for the code that follows them.
 */
export function createValidator(fail: (why: string) => never): StructValidator {
  return {
    object(value, label = 'value') {
      if (!isPlainObject(value)) fail(`expected ${label} to be an object`);
      return value;
    },
    schemaVersion(obj) {
      if (typeof obj.schema_version !== 'string')
        fail('missing schema_version');
      // A distinct, catchable type (thrown directly, not via the generic fail
      // sink) so cache loaders can recover from a stale version while parsers
      // and historical snapshots surface it.
      if (obj.schema_version !== SCHEMA_VERSION) {
        throw new SchemaVersionError(obj.schema_version);
      }
    },
    string(obj, key) {
      if (typeof obj[key] !== 'string') fail(typed(obj, key, 'a string'));
    },
    number(obj, key) {
      if (typeof obj[key] !== 'number') fail(typed(obj, key, 'a number'));
    },
    numberOrNull(obj, key) {
      // `null` is a valid, meaningful value here (e.g. a not-assessed score),
      // distinct from an ABSENT field, which is still a failure.
      if (!(key in obj)) fail(`missing ${key}`);
      const val = obj[key];
      if (val !== null && typeof val !== 'number')
        fail(`${key} must be a number or null`);
    },
    array(obj, key) {
      if (!Array.isArray(obj[key])) fail(typed(obj, key, 'an array'));
    },
    objectField(obj, key) {
      if (!isPlainObject(obj[key])) fail(typed(obj, key, 'an object'));
    },
  };
}
