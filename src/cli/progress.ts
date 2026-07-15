/**
 * Interactive progress rendering for `check` (M11). Turns the orchestrator's
 * structured {@link ProgressEvent}s (core emits data, never renders - hard rule
 * #1) into a live spinner, per-phase checkmarks, and the buyer-prompt list.
 *
 * All output goes to the injected `write` (stderr), so stdout stays pure for
 * `--json`. The animation is time-driven but the committed lines (checkmarks,
 * prompts) are written synchronously on each event, so behavior is testable
 * without waiting on timers.
 */
import type { ProgressEvent } from '../core/run/index.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[K';

export interface ProgressReporter {
  onProgress: (event: ProgressEvent) => void;
  /** Stop any running spinner. Call in a `finally` so a throw never leaks it. */
  stop: () => void;
}

export interface ProgressDeps {
  /** Where frames and lines are written (stderr). */
  write: (s: string) => void;
}

/** "1 prompt" / "3 prompts" - grammatical count. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Build a spinner-backed reporter. Attach only on a TTY (caller's choice). */
export function createProgressReporter(deps: ProgressDeps): ProgressReporter {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let label = '';

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const start = (text: string): void => {
    label = text;
    stopTimer();
    deps.write(`\r${FRAMES[0]} ${label}`);
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      deps.write(`\r${FRAMES[frame]} ${label}`);
    }, 80);
    // Never keep the process alive just for the animation.
    timer.unref?.();
  };

  const commit = (line: string): void => {
    stopTimer();
    deps.write(`${CLEAR_LINE}${line}\n`);
  };

  const onProgress = (event: ProgressEvent): void => {
    switch (event.kind) {
      case 'discovery-start':
        return start('Discovering the brand...');
      case 'discovery-done':
        return commit(`✓ Discovered ${event.brand}`);
      case 'queries-start':
        return start('Generating buyer prompts...');
      case 'queries-done': {
        commit(`✓ Generated ${plural(event.prompts.length, 'buyer prompt')}`);
        event.prompts.forEach((p, i) => deps.write(`  ${i + 1}. ${p}\n`));
        return;
      }
      case 'ask-start':
        return start(`Asking engines (0/${event.total})...`);
      case 'ask-answered': {
        // Just update the label; the running spinner redraws it.
        label = `Asking engines (${event.done}/${event.total})...`;
        return;
      }
      case 'ask-done':
        return commit(`✓ Asked ${plural(event.total, 'prompt')}`);
      case 'scoring-start':
        return start('Scoring answers...');
      case 'scoring-done':
        return commit('✓ Scored');
    }
  };

  return { onProgress, stop: stopTimer };
}
