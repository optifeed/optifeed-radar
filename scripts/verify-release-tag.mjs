#!/usr/bin/env node
/**
 * Release gate: the git tag being published must match package.json's version.
 *
 * npm publishes whatever version is in package.json, regardless of the tag, so
 * without this a `v0.2.0` tag can happily republish 0.1.0 - and the provenance
 * attestation would then point a reader at the wrong commit.
 *
 * Usage: node scripts/verify-release-tag.mjs v0.1.0
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const ref = process.argv[2] ?? '';
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

if (!ref.startsWith('v')) {
  console.error(
    `Release must run from a v* tag, got "${ref}". Dispatch from the tag, not a branch.`,
  );
  process.exit(1);
}

const tagged = ref.slice(1);
if (tagged !== version) {
  console.error(
    `Tag ${ref} does not match package.json version ${version}. Bump one of them and re-tag.`,
  );
  process.exit(1);
}

console.log(`Tag ${ref} matches package.json version ${version}.`);
