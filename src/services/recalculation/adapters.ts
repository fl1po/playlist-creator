import {
  getLikedTracksWithPositions,
  getPlaylistTracksWithPositions,
} from '../../lib/pagination.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import {
  getNonListenedPlaylists,
  invalidateNonListenedCache,
} from '../non-listened-playlists.js';
import {
  deezerPopularitySource,
  promotionReads,
  spotifyPlaylistWrites,
} from '../promotion-sync/adapters.js';
import type { RecalculationPorts, SourceReads } from './index.js';

/** Production SourceReads: snapshot ids and position-aware scans via Spotify. */
export function spotifySourceReads(ctx: SpotifyContext): SourceReads {
  return {
    async snapshots(sources) {
      const snapshotOf = async (playlistId: string, what: string) => {
        const r = await ctx.call(
          () =>
            ctx.api.playlists.getPlaylist(playlistId, undefined, 'snapshot_id'),
          what,
        );
        return r.success ? r.data.snapshot_id : undefined;
      };

      const aw = await snapshotOf(sources.allWeeklyId, 'All Weekly snapshot');
      if (!sources.useLikedSongs) {
        const boaw = await snapshotOf(
          sources.bestOfAllWeeklyId,
          'Best of All Weekly snapshot',
        );
        return { aw, boaw };
      }
      // Liked Songs has no snapshot id: total count + newest addition stands in.
      const liked = await ctx.call(
        () => ctx.api.currentUser.tracks.savedTracks(1, 0),
        'Liked Songs snapshot',
      );
      if (!liked.success) return { aw };
      const data = liked.data as {
        total?: number;
        items?: Array<{ added_at?: string }>;
      };
      return {
        aw,
        boaw: `${data.total ?? 0}:${data.items?.[0]?.added_at ?? ''}`,
      };
    },

    scan(source, sources, onProgress) {
      if (source === 'aw')
        return getPlaylistTracksWithPositions(ctx, sources.allWeeklyId, {
          onProgress,
        });
      return sources.useLikedSongs
        ? getLikedTracksWithPositions(ctx, { onProgress })
        : getPlaylistTracksWithPositions(ctx, sources.bestOfAllWeeklyId, {
            onProgress,
          });
    },
  };
}

/**
 * The production port set for one user. `userId` is the Spotify user id,
 * `dataDir` where that user's non-listened cache lives.
 */
export function spotifyRecalculationPorts(
  ctx: SpotifyContext,
  user: { userId: string; dataDir: string },
): RecalculationPorts {
  return {
    sources: spotifySourceReads(ctx),
    unprocessed: {
      async find(allWeeklyId, log) {
        // Refresh the token up front: a sync usually follows a long scan or
        // fill, and its playlist writes shouldn't be what discovers expiry.
        await ctx.client.recreateApi();
        return getNonListenedPlaylists(
          ctx,
          user.userId,
          allWeeklyId,
          user.dataDir,
          log,
        );
      },
      invalidate: () => invalidateNonListenedCache(user.dataDir, user.userId),
    },
    sync: {
      reads: promotionReads(ctx),
      popularity: deezerPopularitySource(() => {
        void ctx.api; // throws if aborted
      }),
      writes: spotifyPlaylistWrites(ctx),
    },
  };
}
