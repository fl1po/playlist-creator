import {
  itemsOf,
  type PlaylistRead,
  playlistReads,
} from '../../lib/playlist-reads/index.js';
import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { UserSession } from '../../lib/user-session.js';
import type { ReleaseReads } from '../week-collection/index.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import type { PlaylistWrites, PromotionReads } from './index.js';

/** Deezer release popularity, reused from week collection. */
export { deezerPopularitySource } from '../week-collection/adapters.js';

const WRITE_CHUNK = 100;

/**
 * Production PromotionReads adapter: the week-collection ReleaseReads adapter
 * plus the two playlist-track readers. Pass `reads` to share one operation's
 * remembered release reads (a fill's) instead of starting fresh. Playlist
 * tracks come through the session's playlist reads (ADR-0011), always with a
 * live snapshot check: the removal phase edits the very playlists the
 * addition phase reads next, so a listing's snapshot would be stale.
 */
export function promotionReads(
  session: Pick<UserSession, 'gateway' | 'data'>,
  reads: ReleaseReads = spotifyReleaseReads(session.gateway),
): PromotionReads {
  const playlists = playlistReads(session);
  return {
    ...reads,
    async playlistTracksWithArtists(playlistId) {
      const read = await playlists.tracks(playlistId);
      return itemsOf(read).flatMap(({ track }) =>
        track
          ? [
              {
                uri: `spotify:track:${track.id}`,
                id: track.id,
                name: track.name,
                artistNames: track.artists.map((a) => a.name),
                albumId: track.album.id,
              },
            ]
          : [],
      );
    },
    async playlistTrackIds(playlistId) {
      return trackIdsOf(await playlists.tracks(playlistId));
    },
  };
}

/** Every track id on a read playlist, in order; throws if the read failed. */
export function trackIdsOf(read: PlaylistRead): string[] {
  return itemsOf(read).flatMap((i) => (i.track ? [i.track.id] : []));
}

/**
 * Production PlaylistWrites adapter: chunks at Spotify's 100-item limit and
 * formats track ids as `spotify:track:` uris. Throws on any failed chunk —
 * `ctx.call` has already exhausted its own retries by the time it reports
 * failure, so a caller must not treat the write as done.
 */
export function spotifyPlaylistWrites(ctx: SpotifyGateway): PlaylistWrites {
  return {
    async addTracks(playlistId, trackIds) {
      for (let i = 0; i < trackIds.length; i += WRITE_CHUNK) {
        const uris = trackIds
          .slice(i, i + WRITE_CHUNK)
          .map((id) => `spotify:track:${id}`);
        const result = await ctx.call(
          (api) => api.playlists.addItemsToPlaylist(playlistId, uris),
          `add tracks to ${playlistId}`,
        );
        if (!result.success) {
          throw (
            result.error ?? new Error(`Failed to add tracks to ${playlistId}`)
          );
        }
      }
    },
    async removeTracks(playlistId, trackIds) {
      for (let i = 0; i < trackIds.length; i += WRITE_CHUNK) {
        const tracks = trackIds
          .slice(i, i + WRITE_CHUNK)
          .map((id) => ({ uri: `spotify:track:${id}` }));
        const result = await ctx.call(
          (api) =>
            api.playlists.removeItemsFromPlaylist(playlistId, { tracks }),
          `remove tracks from ${playlistId}`,
        );
        if (!result.success) {
          throw (
            result.error ??
            new Error(`Failed to remove tracks from ${playlistId}`)
          );
        }
      }
    },
  };
}
