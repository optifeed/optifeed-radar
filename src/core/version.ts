/**
 * The package version, read at runtime from package.json.
 *
 * One source for every surface that states a version (the CLI's `--version`
 * and the MCP handshake identity). A hardcoded copy drifts silently: the MCP
 * server claimed 0.1.0 while package.json still said 0.0.0.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolved relative to this module so it works both from source via `tsx`
 * (`src/core/version.ts`) and from the built output (`dist/core/version.js`) -
 * in both layouts `../../package.json` is the package root. package.json is
 * always present in a published npm package.
 */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}
