import { fetchDeezerPopularities } from '../../lib/deezer-popularity.js';
import type {
  CheckpointStore,
  PopularitySource,
  WeekProgress,
} from './index.js';

/** Production PopularitySource: Deezer track ranks normalized to 0–100. */
export function deezerPopularitySource(
  checkAbort?: () => void,
): PopularitySource {
  return {
    lookup(releases, onProgress) {
      return fetchDeezerPopularities(releases, { onProgress, checkAbort });
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
