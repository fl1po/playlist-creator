import {
  getLikedTracksWithPositions,
  getPlaylistTracksWithPositions,
} from '../../lib/pagination.js';
import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { UserSession } from '../../lib/user-session.js';
import {
  deezerPopularitySource,
  promotionReads,
  spotifyPlaylistWrites,
} from '../promotion-sync/adapters.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../weekly-playlists/index.js';
import type { RecalculationPorts, SourceReads } from './index.js';

/** Production SourceReads: snapshot ids and position-aware scans via Spotify. */
export function spotifySourceReads(ctx: SpotifyGateway): SourceReads {
  return {
    async snapshots(sources) {
      const snapshotOf = async (playlistId: string, what: string) => {
        const r = await ctx.call(
          (api) =>
            api.playlists.getPlaylist(playlistId, undefined, 'snapshot_id'),
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
        (api) => api.currentUser.tracks.savedTracks(1, 0),
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
 * The production port set for the session's user. Their user data holds
 * what the unprocessed listing reuses between runs.
 */
export function spotifyRecalculationPorts(
  session: UserSession,
): RecalculationPorts {
  const { gateway: ctx, userId, data } = session;
  return {
    sources: spotifySourceReads(ctx),
    unprocessed: {
      find(allWeeklyId, log) {
        return unprocessedWeeklyPlaylists(
          {
            store: spotifyWeeklyPlaylistStore(ctx),
            data,
            userId,
          },
          allWeeklyId,
          log,
        );
      },
    },
    sync: {
      reads: promotionReads(ctx),
      popularity: deezerPopularitySource(() => ctx.signal?.throwIfAborted()),
      writes: spotifyPlaylistWrites(ctx),
    },
  };
}
