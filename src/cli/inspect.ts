/**
 * The read-only inspect commands (M11 follow-up): `diff`, `sources`, `queries`,
 * `config`. Each is THIN over existing core (hard rule #1: no orchestration in
 * cli/) - it resolves paths, reads a persisted artifact via the injected
 * {@link Runtime} fs, and hands the data to an M9 renderer. None spends money.
 */
import { Command } from 'commander';
import {
  ENGINE_KEY_ENV,
  ENGINE_ORDER,
  NoJudgeModelError,
  detectAvailableEngines,
  resolveJudgeModel,
  resolveStateDir,
} from '../core/config.js';
import { loadQueryPack, toYaml } from '../core/queries/index.js';
import {
  diffEnvelopes,
  honestyFields,
  listSnapshots,
  loadSnapshot,
  renderDiffJson,
  renderDiffText,
  renderSourcesText,
} from '../core/output/index.js';
import { SCHEMA_VERSION } from '../core/types.js';
import type { Runtime } from './runtime.js';

/** The state dir a domain's artifacts live in, from the runtime's paths. */
function stateDirFor(rt: Runtime, domain: string): string {
  return resolveStateDir({
    cwd: rt.cwd,
    homeDir: rt.homeDir,
    domain,
    isProjectWritable: rt.isProjectWritable,
  });
}

/** `diff <domain>`: compare the two most recent snapshots for a brand. */
function registerDiff(program: Command, rt: Runtime): void {
  program
    .command('diff')
    .argument('<domain>', 'the brand whose snapshots to compare')
    .description('Compare the two most recent check runs for a brand')
    .option('--json', 'output the raw JSON diff')
    .action(async (domain: string, options: { json?: boolean }) => {
      const stateDir = stateDirFor(rt, domain);
      const paths = await listSnapshots(stateDir, rt.snapshotFs);
      if (paths.length < 2) {
        rt.err(
          `Need at least two snapshots to compare for ${domain}. ` +
            `Run \`check ${domain}\` again to record another.\n`,
        );
        process.exitCode = 1;
        return;
      }
      // listSnapshots is chronological (oldest first): last two are the newest.
      // The two reads are independent I/O, so load them concurrently (lesson #6).
      const [baseline, latest] = await Promise.all([
        loadSnapshot(paths[paths.length - 2]!, rt.snapshotFs),
        loadSnapshot(paths[paths.length - 1]!, rt.snapshotFs),
      ]);
      const diff = diffEnvelopes(baseline, latest);
      rt.out(`${options.json ? renderDiffJson(diff) : renderDiffText(diff)}\n`);
    });
}

/** `sources <domain>`: cited sources + share of voice from the latest snapshot. */
function registerSources(program: Command, rt: Runtime): void {
  program
    .command('sources')
    .argument('<domain>', 'the brand whose latest snapshot to read')
    .description('Show where AI engines drew their answers (cited sources)')
    .option('--json', 'output the raw JSON sources')
    .action(async (domain: string, options: { json?: boolean }) => {
      const stateDir = stateDirFor(rt, domain);
      const paths = await listSnapshots(stateDir, rt.snapshotFs);
      if (paths.length === 0) {
        rt.err(`No snapshot for ${domain} yet. Run: check ${domain}\n`);
        process.exitCode = 1;
        return;
      }
      const env = await loadSnapshot(paths[paths.length - 1]!, rt.snapshotFs);
      if (options.json) {
        // Carry the run's honesty flags through the JSON path too - a partial
        // run must never read as complete in any derived artifact (rule #6).
        // Projected via the shared helper, never enumerated here: this call
        // site listed three flags and silently dropped `partialEngines` when it
        // was added, so the JSON disagreed with the text rendering of the very
        // same snapshot.
        rt.out(
          `${JSON.stringify(
            {
              schema_version: SCHEMA_VERSION,
              domain: env.domain,
              sources: env.sources,
              shareOfVoice: env.shareOfVoice,
              ...honestyFields(env),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      rt.out(`${renderSourcesText(env)}\n`);
    });
}

/** `queries <domain>`: show or export the persisted buyer-prompt pack. */
function registerQueries(program: Command, rt: Runtime): void {
  program
    .command('queries')
    .argument('<domain>', 'the brand whose query pack to show')
    .description('Show or export the buyer-prompt pack for a brand')
    .option('--json', 'output the pack as JSON')
    .option('--export <file>', 'write the pack (YAML) to a file')
    .action(
      async (domain: string, options: { json?: boolean; export?: string }) => {
        const stateDir = stateDirFor(rt, domain);
        const pack = await loadQueryPack(stateDir, rt.queryFs);
        if (!pack) {
          rt.err(`No query pack for ${domain}. Run: check ${domain}\n`);
          process.exitCode = 1;
          return;
        }
        if (options.export) {
          await rt.writeFile(options.export, toYaml(pack));
          rt.err(`Query pack written to ${options.export}\n`);
          return;
        }
        rt.out(
          options.json ? `${JSON.stringify(pack, null, 2)}\n` : toYaml(pack),
        );
      },
    );
}

/** `config`: show detected engine keys, the judge model, and the state dir. */
function registerConfig(program: Command, rt: Runtime): void {
  program
    .command('config')
    .argument('[domain]', 'a brand, to show its exact state directory')
    .description('Show detected engine keys, judge model, and state directory')
    .action(async (domain: string | undefined) => {
      const available = detectAvailableEngines(rt.env);
      const lines: string[] = [
        'Optifeed configuration',
        '',
        'Engine API keys:',
      ];
      for (const engine of ENGINE_ORDER) {
        // Report presence only - never echo the key value (hard rule #4).
        const status = rt.env[ENGINE_KEY_ENV[engine]] ? 'set' : 'not set';
        lines.push(`  ${engine.padEnd(12)}${status}`);
      }
      lines.push('');

      let judge = 'none (set an engine API key)';
      if (available.length > 0) {
        try {
          judge = (
            await resolveJudgeModel({
              interactive: false,
              availableEngines: available,
            })
          ).model;
        } catch (e) {
          if (!(e instanceof NoJudgeModelError)) throw e;
        }
      }
      lines.push(`Judge model: ${judge}`);
      lines.push(`State directory: ${stateDirFor(rt, domain ?? '<domain>')}`);
      rt.out(`${lines.join('\n')}\n`);
    });
}

/** Register all read-only inspect commands on the program. */
export function registerInspect(program: Command, rt: Runtime): void {
  registerDiff(program, rt);
  registerSources(program, rt);
  registerQueries(program, rt);
  registerConfig(program, rt);
}
