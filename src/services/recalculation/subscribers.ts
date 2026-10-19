import type { TaskProgress } from '../../lib/task-progress.js';
import type { RecalculationProgress } from './index.js';

// ── Console subscriber (CLI) ────────────────────────────────────────────────

export function consoleRecalculationProgress(): (
  e: RecalculationProgress,
) => void {
  return (e) => {
    switch (e.phase) {
      case 'recalculating':
        console.log('Recalculating artist priorities...');
        break;
      case 'scan-start':
        console.log(`\nScanning ${e.name}...`);
        break;
      case 'scan-progress':
        process.stdout.write(`\r  Fetched ${e.fetched}/${e.total} tracks`);
        break;
      case 'scan-done':
        console.log(
          `${e.cached ? `${e.name} (cached):` : '\n '} ${e.artists} unique artists in ${e.tracks} tracks`,
        );
        break;
    }
  };
}

// ── Broadcast subscriber (web) ──────────────────────────────────────────────

export function broadcastRecalculationProgress(
  broadcast: (type: string, data: unknown) => void,
  progress: TaskProgress,
  checkAbort: () => void,
): (e: RecalculationProgress) => void {
  return (e) => {
    switch (e.phase) {
      case 'recalculating':
        break;
      case 'scan-start':
        checkAbort();
        broadcast('recalc:scanStart', { playlist: e.name });
        break;
      case 'scan-progress':
        checkAbort();
        progress.bar(
          'recalc',
          e.fetched,
          e.total,
          `${e.name}: ${e.fetched}/${e.total}`,
        );
        break;
      case 'scan-done':
        progress.clearBar('recalc');
        broadcast('log', {
          level: 'info',
          message: `${e.cached ? `${e.name} (cached)` : e.name}: ${e.artists} artists, ${e.tracks} tracks`,
        });
        break;
    }
  };
}
