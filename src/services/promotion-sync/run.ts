import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../../lib/types.js';
import {
  getNonListenedPlaylists,
  invalidateNonListenedCache,
} from '../non-listened-playlists.js';
import {
  deezerPopularitySource,
  promotionReads,
  spotifyPlaylistWrites,
} from './adapters.js';
import {
  type PriorityChange,
  type PromotionSyncResult,
  syncPriorityChanges,
} from './index.js';
import type { SyncHandlers } from './subscribers.js';

export interface SyncDeps {
  ctx: SpotifyContext;
  dataDir: string;
  userId: string;
  handlers: SyncHandlers;
}

export interface SyncRunInput {
  allWeeklyId: string;
  minPopularity: number;
  /** Authoritative (post-recalc) roster — callers must pass the freshly
   *  recalculated priorities, not a possibly-stale on-disk copy. */
  trustedArtists: TrustedArtistsFile;
}

/**
 * Run promotion sync if any P1/P2 boundary crossings occurred; a no-op
 * (returns null) otherwise. Reuses the caller's SpotifyContext — no separate
 * pacer/context is built, so rate-limit logging during sync reads the same as
 * during the fill or recalculation that triggered it.
 */
export async function syncIfNeeded(
  changes: PriorityChange[],
  deps: SyncDeps,
  input: SyncRunInput,
): Promise<PromotionSyncResult | null> {
  const isP1P2 = (p: number | null) => p === 1 || p === 2;
  const hasBoundaryCrossing = changes.some(
    (c) => isP1P2(c.from) !== isP1P2(c.to),
  );
  if (!hasBoundaryCrossing) return null;

  const { ctx, dataDir, userId, handlers } = deps;
  const { allWeeklyId, minPopularity, trustedArtists } = input;

  await ctx.client.recreateApi();

  const { playlists, awTrackIds } = await getNonListenedPlaylists(
    ctx,
    userId,
    allWeeklyId,
    dataDir,
    (message, level) => handlers.onLog(message, level),
  );
  if (playlists.length === 0) {
    handlers.onLog('No unprocessed weekly playlists found');
    return null;
  }

  const result = await syncPriorityChanges(
    changes,
    {
      unprocessedPlaylists: playlists,
      awTrackIds,
      trustedArtists,
      // Newly-promoted artists backfill their whole recent back-catalogue, so
      // hold them to a higher bar than the weekly gate — twice the configured
      // minimum — to keep stale low-popularity releases out.
      minPopularity: minPopularity * 2,
    },
    {
      reads: promotionReads(ctx),
      popularity: deezerPopularitySource(() => {
        void ctx.api; // throws if aborted
      }),
      writes: spotifyPlaylistWrites(ctx),
    },
    (e) => handlers.onProgress(e),
  );

  if (result.removed > 0 || result.added > 0) {
    invalidateNonListenedCache(dataDir, userId);
  }
  handlers.onComplete(result);
  return result;
}
