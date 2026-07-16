/**
 * The `lint-feed <url>` command (M14's CLI surface). THIN over
 * `lintFeedUrl` (core/lintfeed) then an M9 renderer - no lint logic lives here
 * (hard rule #1). Spends nothing: the rules are deterministic, no AI engines
 * are queried.
 */
import process from 'node:process';
import { Command } from 'commander';
import { lintFeedUrl } from '../core/lintfeed/index.js';
import {
  renderFeedLintJson,
  renderFeedLintText,
} from '../core/output/index.js';
import type { Runtime } from './runtime.js';

/** Register `lint-feed <url>` on the program. */
export function registerLintFeed(program: Command, rt: Runtime): void {
  program
    .command('lint-feed')
    .argument('<url>', 'the product feed to lint, e.g. https://shop/feed.xml')
    .description(
      'Check a product feed against the ACP and UCP shopping protocols (no API keys)',
    )
    .option('--json', 'output the raw JSON report')
    .action(async (url: string, options: { json?: boolean }) => {
      const report = await lintFeedUrl(url, rt.fetcher);
      rt.out(
        `${options.json ? renderFeedLintJson(report) : renderFeedLintText(report)}\n`,
      );
      // A feed we could not assess (unfetchable, malformed, empty) is a failed
      // run, not a clean one - exit non-zero so CI never reads it as a pass.
      // Findings alone do NOT fail the command: reporting is not gating.
      if (report.feedScore === null) process.exitCode = 1;
    });
}
