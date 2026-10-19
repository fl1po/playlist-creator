import { type LogLevel, printLines } from '../../lib/task-log.js';
import type { TaskProgress } from '../../lib/task-progress.js';
import type { DateResult } from '../../lib/types.js';
import type { PriorityChange } from '../promotion-sync/index.js';
import { describeFill } from './describe.js';
import type { FillEvent } from './events.js';

// ── Console sink (CLI) ──────────────────────────────────────────────────────

export function consoleFillSink(e: FillEvent): void {
  printLines(describeFill(e));
}

// ── Web sink ────────────────────────────────────────────────────────────────

/** The fill's results the page acts on: data only, never text (ADR-0007). */
export interface FillResultEvents {
  'fill:recalculated': { changes: PriorityChange[] };
  'fill:complete': { results: DateResult[]; duration: number };
}

export interface WebFillSinkOptions {
  log: (level: LogLevel, message: string) => void;
  emit: <K extends keyof FillResultEvents>(
    type: K,
    data: FillResultEvents[K],
  ) => void;
  /** The owner's view of where the fill is (ADR-0006). */
  progress: TaskProgress;
  /** Throws if the user requested abort. Called at hot-path events. */
  checkAbort: () => void;
}

export function webFillSink(opts: WebFillSinkOptions): (e: FillEvent) => void {
  const { log, emit, progress, checkAbort } = opts;
  /** Index of the date being filled, for the step strip. */
  let current = 0;

  function track(e: FillEvent): void {
    switch (e.kind) {
      case 'start':
        checkAbort();
        progress.steps(e.dates);
        progress.bar('fillCurrent', 0, 1, 'Starting...');
        break;
      case 'resumed':
        if (e.artists.length) progress.mark(...e.artists);
        break;
      case 'date-start':
        checkAbort();
        current = e.index;
        progress.step(e.index, 'active');
        progress.bar('fillCurrent', 0, 1, `${e.date}: starting...`);
        break;
      case 'week':
        if (e.event.phase === 'searching') {
          checkAbort();
          progress.mark(e.event.artist);
          progress.bar(
            'fillCurrent',
            e.event.searched,
            e.event.total,
            `Searching artists: ${e.event.searched}/${e.event.total}`,
          );
        }
        break;
      case 'date-complete':
        progress.step(current, e.result.skipped ? 'skipped' : 'done');
        progress.bar(
          'fillCurrent',
          1,
          1,
          `${e.result.date}: done — ${e.result.tracksAdded} tracks`,
        );
        break;
      case 'date-error':
        progress.step(current, 'error');
        break;
      case 'recalculated':
        emit('fill:recalculated', { changes: e.changes });
        break;
      case 'complete':
        // The trailing promotion sync may still run; the dates are done.
        progress.steps([]);
        progress.clearBar('fillCurrent');
        emit('fill:complete', {
          results: e.results,
          duration: e.durationMinutes,
        });
        break;
    }
  }

  return (e) => {
    track(e);
    for (const l of describeFill(e)) log(l.level, l.message);
  };
}
