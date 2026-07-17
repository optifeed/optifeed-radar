import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from './types.js';
import { createValidator, SchemaVersionError } from './validation.js';

/** A fail sink that records the reason and throws, matching real loader use. */
class ValidationError extends Error {}
function sink(): (why: string) => never {
  return (why) => {
    throw new ValidationError(why);
  };
}

describe('createValidator', () => {
  it('object() returns the value typed as a record when it is a plain object', () => {
    const v = createValidator(sink());
    const obj = v.object({ a: 1 }, 'thing');
    expect(obj).toEqual({ a: 1 });
  });

  it('object() fails on null, arrays, and primitives', () => {
    const v = createValidator(sink());
    expect(() => v.object(null)).toThrow(ValidationError);
    expect(() => v.object([1, 2])).toThrow(ValidationError);
    expect(() => v.object('str')).toThrow(ValidationError);
  });

  it('schemaVersion() passes when it matches the supported version', () => {
    const v = createValidator(sink());
    expect(() =>
      v.schemaVersion({ schema_version: SCHEMA_VERSION }),
    ).not.toThrow();
  });

  it('schemaVersion() fails when the field is missing', () => {
    const v = createValidator(sink());
    expect(() => v.schemaVersion({})).toThrow(ValidationError);
  });

  it('schemaVersion() throws a distinct SchemaVersionError on an incompatible value (rule #2)', () => {
    // A DISTINCT type (not the generic fail sink) so cache loaders can catch it
    // and rebuild, while parsers/historical snapshots let it surface.
    const v = createValidator(sink());
    expect(() => v.schemaVersion({ schema_version: '0.1' })).toThrow(
      SchemaVersionError,
    );
  });

  it('distinguishes an absent field from a present-but-wrong-typed one', () => {
    const v = createValidator(sink());
    // Absent -> "missing"; present-but-wrong-type -> "must be", so a user
    // editing the file is not told a field is gone when it is only mis-typed.
    expect(() => v.string({}, 'domain')).toThrow(/missing domain/);
    expect(() => v.string({ domain: 123 }, 'domain')).toThrow(
      /domain must be a string/,
    );
    expect(() => v.array({ xs: 'nope' }, 'xs')).toThrow(/xs must be an array/);
    expect(() => v.number({ n: 'x' }, 'n')).toThrow(/n must be a number/);
    expect(() => v.objectField({ o: [1] }, 'o')).toThrow(/o must be an object/);
  });

  it('string()/array()/number()/objectField() enforce their types', () => {
    const v = createValidator(sink());
    const ok = { s: 'x', a: [1], n: 2, o: { k: 1 } };
    expect(() => v.string(ok, 's')).not.toThrow();
    expect(() => v.array(ok, 'a')).not.toThrow();
    expect(() => v.number(ok, 'n')).not.toThrow();
    expect(() => v.objectField(ok, 'o')).not.toThrow();

    expect(() => v.string(ok, 'n')).toThrow(ValidationError);
    expect(() => v.array(ok, 's')).toThrow(ValidationError);
    expect(() => v.number(ok, 's')).toThrow(ValidationError);
    expect(() => v.objectField(ok, 'a')).toThrow(ValidationError); // array is not an object field
  });
});
