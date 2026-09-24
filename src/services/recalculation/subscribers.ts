import type { PriorityChange } from '../promotion-sync/index.js';
import type { SyncHandlers } from '../promotion-sync/subscribers.js';
import type { RecalculationProgress, SyncProgress } from './index.js';

/** Route `syncPending`'s progress into the existing promotion-sync renderers. */
export function syncProgressTo(
  handlers: SyncHandlers,
): (e: SyncProgress) => void {
  return (e) =>
    e.phase === 'log'
      ? handlers.onLog(e.message, e.level)
      : handlers.onProgress(e);
}

export function describeChange(c: PriorityChange): string {
  const from = c.from === null ? 'new' : `P${c.from}`;
  const to = c.to === null ? 'none' : `P${c.to}`;
  return `${from} → ${to}: ${c.artist}`;
}

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
        broadcast('recalc:scanProgress', {
          playlist: e.name,
          offset: e.fetched,
          total: e.total,
        });
        break;
      case 'scan-done':
        broadcast('recalc:scanProgress', {
          playlist: e.cached ? `${e.name} (cached)` : e.name,
          artists: e.artists,
          tracks: e.tracks,
        });
        break;
    }
  };
}
