/**
 * How the MCP stdio entrypoint resolves its environment. Split out of
 * `index.ts` so it is testable without connecting a transport (`index.ts`
 * runs its `main()` on import).
 */
import { homedir } from 'node:os';
import process from 'node:process';
import type { DefaultToolContextInput } from './deps.js';

export interface EntryDeps {
  env: Record<string, string | undefined>;
  cwd: () => string;
  homedir: () => string;
}

/**
 * Build the context input for the stdio server.
 *
 * Home comes from `os.homedir()`, never `env.HOME`: Windows sets USERPROFILE
 * instead, so reading HOME there falls through to cwd - and a desktop client
 * launches the server with an arbitrary cwd (often its own install dir, or
 * `/`). That is precisely the "scatter `.optifeed` wherever the client started
 * us" outcome this design exists to avoid, and with `isProjectWritable: false`
 * every write is anchored on this value.
 */
export function mcpContextInput(
  deps: EntryDeps = { env: process.env, cwd: () => process.cwd(), homedir },
): DefaultToolContextInput {
  return {
    env: deps.env,
    cwd: deps.cwd(),
    homeDir: deps.homedir(),
    // DELIBERATE: the MCP server always writes state under the home dir, unlike
    // the CLI which prefers `<cwd>/.optifeed` when cwd is writable. A stable
    // home-anchored location is predictable for a server with an arbitrary cwd.
    // The trade-off: snapshots written by a CLI run in a project dir are not
    // visible to `get_snapshot_diff` over MCP (and vice versa). Revisit if
    // agents and humans need to share one brand's history across entrypoints.
    isProjectWritable: false,
  };
}
