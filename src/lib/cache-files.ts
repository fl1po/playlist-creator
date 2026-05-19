export const LISTENING_TIME_CACHE = 'listening-time-cache.json';
export const DURATION_SNAPSHOT_CACHE = 'duration-snapshots.json';
export const AW_BREAKDOWN_CACHE = 'aw-breakdown.json';

export interface DurationSnapshot {
  snapshotId: string;
  totalMs: number;
  trackCount: number;
}

export type DurationSnapshots = Record<string, DurationSnapshot>;
