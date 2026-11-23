import { type LogLevel, printLines } from '../../lib/task-log.js';
import type { TaskProgress } from '../../lib/task-progress.js';
import { describeRecalculation } from './describe.js';
import type { RecalculationProgress } from './index.js';

// ── Console sink (CLI) ──────────────────────────────────────────────────────

export function consoleRecalculationProgress(): (
  e: RecalculationProgress,
) => void {
  let fetching = false;
  return (e) => {
    // The terminal's progress, as the web's is its bar.
    if (e.phase === 'scan-progress') {
      fetching = true;
      process.stdout.write(
        `\r  ${e.name}: fetched ${e.fetched}/${e.total} tracks`,
      );
      return;
    }
    if (e.phase === 'scan-read' && fetching) {
      fetching = false;
      process.stdout.write('\n');
    }
    printLines(describeRecalculation(e));
  };
}

// ── Web sink ────────────────────────────────────────────────────────────────

export function webRecalculationProgress(opts: {
  log: (level: LogLevel, message: string) => void;
  progress: TaskProgress;
  checkAbort: () => void;
}): (e: RecalculationProgress) => void {
  const { log, progress, checkAbort } = opts;
  return (e) => {
    switch (e.phase) {
      case 'scan-progress':
        checkAbort();
        progress.bar(
          'recalc',
          e.fetched,
          e.total,
          `${e.name}: ${e.fetched}/${e.total}`,
        );
        break;
      case 'scan-read':
        progress.clearBar('recalc');
        break;
    }
    for (const l of describeRecalculation(e)) log(l.level, l.message);
  };
}
