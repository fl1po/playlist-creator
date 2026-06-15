import {
  getAllPlaylistTracks,
  getPlaylistTracksWithArtists,
} from '../../lib/pagination.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import type { PlaylistWrites, PromotionReads } from './index.js';

/** Release popularity lookup, reused from week collection (Deezer / fixed map). */
export { deezerPopularitySource } from '../week-collection/adapters.js';

const WRITE_CHUNK = 100;

/**
 * Production PromotionReads adapter: the week-collection ReleaseReads adapter
 * plus the two playlist-track readers.
 */
export function promotionReads(ctx: SpotifyContext): PromotionReads {
  return {
    ...spotifyReleaseReads(ctx),
    playlistTracksWithArtists(playlistId) {
      return getPlaylistTracksWithArtists(ctx, playlistId);
    },
    playlistTrackIds(playlistId) {
      return getAllPlaylistTracks(ctx, playlistId);
    },
  };
}

/**
 * Production PlaylistWrites adapter: chunks at Spotify's 100-item limit and
 * formats track ids as `spotify:track:` uris.
 */
export function spotifyPlaylistWrites(ctx: SpotifyContext): PlaylistWrites {
  return {
    async addTracks(playlistId, trackIds) {
      for (let i = 0; i < trackIds.length; i += WRITE_CHUNK) {
        const uris = trackIds
          .slice(i, i + WRITE_CHUNK)
          .map((id) => `spotify:track:${id}`);
        await ctx.call(
          () => ctx.api.playlists.addItemsToPlaylist(playlistId, uris),
          `add tracks to ${playlistId}`,
        );
      }
    },
    async removeTracks(playlistId, trackIds) {
      for (let i = 0; i < trackIds.length; i += WRITE_CHUNK) {
        const tracks = trackIds
          .slice(i, i + WRITE_CHUNK)
          .map((id) => ({ uri: `spotify:track:${id}` }));
        await ctx.call(
          () =>
            ctx.api.playlists.removeItemsFromPlaylist(playlistId, { tracks }),
          `remove tracks from ${playlistId}`,
        );
      }
    },
  };
}
