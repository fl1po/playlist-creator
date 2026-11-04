import {
  itemsOf,
  type PlaylistItem,
  playlistReads,
} from '../../lib/playlist-reads/index.js';
import type { PlaylistArtistData } from '../../lib/types.js';
import type { UserSession } from '../../lib/user-session.js';
import {
  deezerPopularitySource,
  promotionReads,
  spotifyPlaylistWrites,
} from '../promotion-sync/adapters.js';
import type { ReleaseReads } from '../week-collection/index.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../weekly-playlists/index.js';
import type { RecalculationPorts, SourceReads, SourceScan } from './index.js';

/**
 * Per-artist counts and latest position over a source's items. Positions run
 * oldest to newest (higher is more recent) and count every slot; `newestFirst`
 * flips Liked Songs, which Spotify lists newest first.
 */
export function scanPositions(
  items: PlaylistItem[],
  newestFirst = false,
): Omit<SourceScan, 'cached'> {
  const artistData = new Map<string, PlaylistArtistData>();
  const total = items.length;
  items.forEach((item, position) => {
    if (!item.track) return;
    const logicalPosition = newestFirst ? total - 1 - position : position;
    item.track.artists.forEach((artist, index) => {
      const isFeatured = index !== 0;
      let data = artistData.get(artist.name);
      if (!data) {
        data = {
          primaryCount: 0,
          featuredCount: 0,
          latestPosition: -1,
          featuredAtLatest: false,
          id: artist.id,
        };
        artistData.set(artist.name, data);
      }
      if (isFeatured) data.featuredCount++;
      else data.primaryCount++;
      if (logicalPosition > data.latestPosition) {
        data.latestPosition = logicalPosition;
        data.featuredAtLatest = isFeatured;
      }
    });
  });
  return { artistData, totalTracks: total };
}

/**
 * Production SourceReads: snapshot ids via Spotify, scans over the session's
 * playlist reads, so a source that didn't change since any earlier read costs
 * no item pages.
 */
export function spotifySourceReads(
  session: Pick<UserSession, 'gateway' | 'data'>,
): SourceReads {
  const ctx = session.gateway;
  const playlists = playlistReads(session);
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

    async scan(source, sources, onProgress) {
      const liked = source === 'boaw' && sources.useLikedSongs;
      const read = liked
        ? await playlists.likedSongs({ onProgress })
        : await playlists.tracks(
            source === 'aw' ? sources.allWeeklyId : sources.bestOfAllWeeklyId,
            { onProgress },
          );
      const scan = scanPositions(itemsOf(read), liked);
      return { ...scan, cached: read.success && read.cached };
    },
  };
}

/**
 * The production port set for the session's user. Their user data holds
 * what the unprocessed listing reuses between runs. A fill passes its own
 * `reads` so promotion sync shares the release reads its weeks remembered.
 */
export function spotifyRecalculationPorts(
  session: UserSession,
  opts: { reads?: ReleaseReads } = {},
): RecalculationPorts {
  const { userId, data } = session;
  return {
    sources: spotifySourceReads(session),
    unprocessed: {
      find(allWeeklyId, log) {
        return unprocessedWeeklyPlaylists(
          {
            store: spotifyWeeklyPlaylistStore(session),
            data,
            userId,
          },
          allWeeklyId,
          log,
        );
      },
    },
    sync: {
      reads: promotionReads(session, opts.reads),
      popularity: deezerPopularitySource(() =>
        session.gateway.signal?.throwIfAborted(),
      ),
      writes: spotifyPlaylistWrites(session.gateway),
    },
  };
}
