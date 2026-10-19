import { type LogLine, line } from '../../lib/task-log.js';
import {
  describePromotionProgress,
  describeSyncResult,
} from '../promotion-sync/describe.js';
import type { PriorityChange } from '../promotion-sync/index.js';
import type { SyncProgress } from './index.js';

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
