import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { BatchCache } from '../../lib/types.js';
import { promotionReads } from '../promotion-sync/adapters.js';
import { spotifyRecalculationPorts } from '../recalculation/adapters.js';
import { deezerPopularitySource } from '../week-collection/adapters.js';
import type { CheckpointStore } from '../week-collection/index.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import type { FillPorts } from './fill-run.js';
import type { FillStorage } from './storage.js';

/**
 * Production CheckpointStore: week progress lives in
 * `BatchCache.artistSearchProgress`, persisted through FillStorage (file or
 * Redis-mirrored). The batch cache is read once, on first use, and this holds
 * the live copy so its other fields survive every save.
 */
export function batchCacheCheckpoints(storage: FillStorage): CheckpointStore {
  let cache: BatchCache | null = null;
  const live = async (): Promise<BatchCache> => {
    if (!cache) cache = await storage.loadBatchCache();
    return cache;
  };
  return {
    async load(week) {
      const p = (await live()).artistSearchProgress;
      if (!p || p.date !== week) return null;
      return {
        week: p.date,
        artistsSearched: p.artistsSearched,
        foundReleases: p.foundReleases,
      };
    },
    async save(progress) {
      const c = await live();
      c.artistSearchProgress = {
        date: progress.week,
        artistsSearched: progress.artistsSearched,
        foundReleases: progress.foundReleases,
      };
      await storage.saveBatchCache(c);
    },
    async clear() {
      const c = await live();
      c.artistSearchProgress = undefined;
      await storage.saveBatchCache(c);
    },
  };
}

/**
 * The production port set for one user's fill. `dataDir` is where that
 * user's unprocessed-playlists cache lives; `storage` is where week progress
 * is persisted.
 */
export function fillPorts(
  ctx: SpotifyContext,
  user: { userId: string; dataDir: string; storage: FillStorage },
): FillPorts {
  return {
    week: {
      reads: spotifyReleaseReads(ctx),
      popularity: deezerPopularitySource(() => {
        void ctx.api; // throws if aborted
      }),
      checkpoints: batchCacheCheckpoints(user.storage),
    },
    weekly: spotifyWeeklyPlaylistStore(ctx),
    history: promotionReads(ctx),
    recalculation: spotifyRecalculationPorts(ctx, user),
  };
}
