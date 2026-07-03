import type { CacheDescriptor } from './durable-cache.js';
import type { BatchCache, TrustedArtistsFile } from './types.js';

export const LISTENING_TIME_CACHE = 'listening-time-cache.json';
export const DURATION_SNAPSHOT_CACHE = 'duration-snapshots.json';
export const AW_BREAKDOWN_CACHE = 'aw-breakdown.json';

export interface DurationSnapshot {
  snapshotId: string;
  totalMs: number;
  trackCount: number;
}

export type DurationSnapshots = Record<string, DurationSnapshot>;

export const TRUSTED_ARTISTS: CacheDescriptor<TrustedArtistsFile> = {
  redisName: 'trustedArtists',
  file: 'trusted-artists.json',
};

export const BATCH_CACHE: CacheDescriptor<BatchCache> = {
  redisName: 'batchCache',
  file: 'batch-cache.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

export const FILL_HISTORY: CacheDescriptor<unknown[]> = {
  redisName: 'fillHistory',
  file: 'fill-history.json',
  isEmpty: (v) => !Array.isArray(v) || v.length === 0,
};

export const DURATION_SNAPSHOTS: CacheDescriptor<DurationSnapshots> = {
  redisName: 'durationSnapshots',
  file: DURATION_SNAPSHOT_CACHE,
};

export const LISTENING_TIME: CacheDescriptor<unknown> = {
  redisName: 'listeningTime',
  file: LISTENING_TIME_CACHE,
};

export const AW_BREAKDOWN: CacheDescriptor<unknown> = {
  redisName: 'awBreakdown',
  file: AW_BREAKDOWN_CACHE,
};

export const NON_LISTENED: CacheDescriptor<unknown> = {
  redisName: 'nonListened',
  file: 'non-listened-cache.json',
};
