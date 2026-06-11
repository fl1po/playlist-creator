import { fetchDeezerPopularities } from '../../lib/deezer-popularity.js';
import type { BatchCache } from '../../lib/types.js';
import type { FillStorage } from '../playlist-filler/storage.js';
import type {
  CheckpointStore,
  PopularitySource,
  WeekProgress,
} from './index.js';

/** Production PopularitySource: Deezer track ranks normalized to 0–100. */
export function deezerPopularitySource(): PopularitySource {
  return {
    lookup(releases, onProgress) {
      return fetchDeezerPopularities(releases, { onProgress });
    },
  };
}

/** Fixed-map PopularitySource for tests. Omitted ids count as unknown. */
export function fixedPopularitySource(
  scores: Record<string, number>,
): PopularitySource {
  return {
    async lookup() {
      return new Map(Object.entries(scores));
    },
  };
}

/**
 * Production CheckpointStore: week progress lives in
 * `BatchCache.artistSearchProgress`, persisted through FillStorage (file or
 * Redis-mirrored). Holds the live cache object so snapshots and scan caches
 * written by the fill are preserved on every save.
 */
export function batchCacheCheckpoints(
  storage: FillStorage,
  cache: BatchCache,
): CheckpointStore {
  return {
    async load(week) {
      const p = cache.artistSearchProgress;
      if (!p || p.date !== week) return null;
      return {
        week: p.date,
        artistsSearched: p.artistsSearched,
        foundReleases: p.foundReleases,
      };
    },
    async save(progress) {
      cache.artistSearchProgress = {
        date: progress.week,
        artistsSearched: progress.artistsSearched,
        foundReleases: progress.foundReleases,
      };
      await storage.saveBatchCache(cache);
    },
    async clear() {
      cache.artistSearchProgress = undefined;
      await storage.saveBatchCache(cache);
    },
  };
}

/** In-memory CheckpointStore for tests and one-off runs. */
export function memoryCheckpoints(): CheckpointStore & {
  current: WeekProgress | null;
} {
  return {
    current: null,
    async load(week) {
      return this.current?.week === week ? this.current : null;
    },
    async save(progress) {
      this.current = progress;
    },
    async clear() {
      this.current = null;
    },
  };
}
