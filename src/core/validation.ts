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
  /** Assert `obj[key]` is an array. */
  array(obj: Unvalidated, key: string): void;
  /** Assert `obj[key]` is a non-null, non-array object. */
  objectField(obj: Unvalidated, key: string): void;
}

function isPlainObject(v: unknown): v is Unvalidated {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
      if (obj.schema_version !== SCHEMA_VERSION) {
        fail(
          `schema_version ${String(obj.schema_version)} is not supported (expected ${SCHEMA_VERSION})`,
        );
      }
    },
    string(obj, key) {
      if (typeof obj[key] !== 'string') fail(`missing ${key}`);
    },
    number(obj, key) {
      if (typeof obj[key] !== 'number') fail(`missing ${key}`);
    },
    array(obj, key) {
      if (!Array.isArray(obj[key])) fail(`${key} must be an array`);
    },
    objectField(obj, key) {
      if (!isPlainObject(obj[key])) fail(`missing ${key}`);
    },
  };
}
