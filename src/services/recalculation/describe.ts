import { type LogLine, line } from '../../lib/task-log.js';
import {
  describePromotionProgress,
  describeSyncResult,
} from '../promotion-sync/describe.js';
import type { PriorityChange } from '../promotion-sync/index.js';
import type {
  RecalculationProgress,
  RecalculationResult,
  SyncProgress,
} from './index.js';

export function describeChange(c: PriorityChange): string {
  const from = c.from === null ? 'new' : `P${c.from}`;
  const to = c.to === null ? 'none' : `P${c.to}`;
  return `${from} → ${to}: ${c.artist}`;
}

/** A recalculation's tier moves as task-log lines (ADR-0007). */
export function describeChanges(changes: PriorityChange[]): LogLine[] {
  if (changes.length === 0) return [line('No priority changes detected')];
  return [
    line(`${changes.length} artist(s) changed priority:`),
    ...changes.map((c) => line(`  ${describeChange(c)}`)),
  ];
}

/** `syncPending`'s task-log lines. */
export function describeSync(e: SyncProgress): LogLine[] {
  switch (e.phase) {
    case 'log':
      return [line(e.message, e.level)];
    case 'complete':
      return describeSyncResult(e.result);
    default:
      return describePromotionProgress(e);
  }
}

/** A recalculation's scans as task-log lines; scan progress is liveness. */
export function describeRecalculation(e: RecalculationProgress): LogLine[] {
  switch (e.phase) {
    case 'recalculating':
      return [line('Recalculating artist priorities...')];
    case 'scan-start':
      return [line(`Scanning ${e.name}...`)];
    case 'scan-progress':
      return [];
    case 'scan-done':
      return [
        line(
          `${e.cached ? `${e.name} (cached)` : e.name}: ${e.artists} artists, ${e.tracks} tracks`,
        ),
      ];
  }
}

/** What a standalone recalculation came to. */
export function describeRecalculationResult(
  result: RecalculationResult,
): LogLine[] {
  if (result.outcome === 'unchanged') {
    return [line('Snapshots unchanged — skipping recalculation')];
  }
  const s = result.roster.metadata.stats;
  return [
    line(
      `Priorities: P1=${s.p1Count} P2=${s.p2Count} P3=${s.p3Count} P4=${s.p4Count}`,
    ),
    ...describeChanges(result.changes),
    line('Priorities recalculated and saved', 'success'),
  ];
}
