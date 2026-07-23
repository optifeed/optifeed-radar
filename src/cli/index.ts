#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Command } from 'commander';
import { getVersion } from '../core/index.js';
import { renderAuditJson, renderAuditText } from '../core/output/index.js';
import { runAudit } from '../core/run/index.js';
import { registerCheck, rejectStrayArgs } from './check.js';
import { registerInspect } from './inspect.js';
import { registerShopping } from './shopping.js';
import { type Runtime, defaultRuntime } from './runtime.js';

/** Re-exported so existing importers of the CLI entrypoint keep working. */
export { getVersion };

/** Register `audit <domain>` (zero-key path) on the program. */
function registerAudit(program: Command, rt: Runtime): void {
  program
    .command('audit')
    .argument('<domain>', 'the site to audit, e.g. example.com')
    .allowExcessArguments(true) // handled by rejectStrayArgs for a clean error
    .description('Static AI-readiness audit (no API keys, no AI calls)')
    .option('--json', 'output the raw JSON report')
    .action(
      async (domain: string, options: { json?: boolean }, command: Command) => {
        if (rejectStrayArgs(rt, command)) return;
        const report = await runAudit(domain, { fetcher: rt.fetcher });
        const out = options.json
          ? renderAuditJson(report)
          : renderAuditText(report);
        rt.out(`${out}\n`);
      },
    );
}

/**
 * Build the commander program. Side-effect free (no parse) so tests can drive
 * it with an injected {@link Runtime} and inspect output.
 */
export function buildProgram(rt: Runtime = defaultRuntime()): Command {
  const program = new Command();
  program
    .name('optifeed-radar')
    .description(
      'Open-source AI visibility checker. Is your brand recommended by AI engines?',
    )
    .version(getVersion(), '-v, --version', 'print the version');

  registerAudit(program, rt);
  registerCheck(program, rt);
  registerShopping(program, rt);
  registerInspect(program, rt);

  return program;
}

/** True when this file is being executed directly (not imported by a test). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
