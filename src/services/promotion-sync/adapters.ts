import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { PlaylistWrites } from './index.js';

/** Deezer release popularity, reused from week collection. */
export { deezerPopularitySource } from '../week-collection/adapters.js';

const WRITE_CHUNK = 100;

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
