import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type {
  AlbumTrack,
  ApiResult,
  PlaylistAlbumInfo,
  SimplePlaylist,
} from "./types.js";

type ApiCallFn = <T>(
  fn: () => Promise<T>,
  description: string,
) => Promise<ApiResult<T>>;

/** Get all track IDs from a playlist. */
export async function getAllPlaylistTracks(
  api: SpotifyApi,
  playlistId: string,
  apiCall: ApiCallFn,
): Promise<string[]> {
  const tracks: string[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await apiCall(
      () =>
        api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const item of result.data.items) {
      if (item.track && item.track.id) {
        tracks.push(item.track.id);
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 100));
  }

  return tracks;
}

/** Get all playlists owned by a user. */
export async function getAllUserPlaylists(
  api: SpotifyApi,
  userId: string,
  apiCall: ApiCallFn,
): Promise<SimplePlaylist[]> {
  const playlists: SimplePlaylist[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await apiCall(
      () => api.playlists.getUsersPlaylists(userId, limit, offset),
      "user playlists",
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return playlists;
    }

    for (const playlist of result.data.items) {
      if (playlist.owner.id === userId) {
        playlists.push({
          id: playlist.id,
          name: playlist.name,
          trackCount: playlist.tracks.total,
        });
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 100));
  }

  return playlists;
}

/** Get all tracks from an album with normalized dedup keys. */
export async function getAlbumTracks(
  api: SpotifyApi,
  albumId: string,
  apiCall: ApiCallFn,
): Promise<AlbumTrack[]> {
  const tracks: AlbumTrack[] = [];
  let offset = 0;

  while (true) {
    const result = await apiCall(
      () => api.albums.tracks(albumId, undefined, 50, offset),
      `tracks for album ${albumId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const track of result.data.items) {
      const artistNames = track.artists
        .map((a: { name: string }) => a.name.toLowerCase())
        .sort()
        .join("|");
      const trackKey = `${artistNames}::${track.name.toLowerCase()}`;
      tracks.push({
        id: track.id,
        name: track.name,
        key: trackKey,
        explicit: (track as unknown as { explicit?: boolean }).explicit,
      });
    }

    if (result.data.items.length < 50) break;
    offset += 50;
    await new Promise((r) => setTimeout(r, 100));
  }

  return tracks;
}

/** Get unique albums referenced by tracks in a playlist. */
export async function getPlaylistAlbums(
  api: SpotifyApi,
  playlistId: string,
  apiCall: ApiCallFn,
  maxOffset = 200,
): Promise<Map<string, PlaylistAlbumInfo>> {
  const albums = new Map<string, PlaylistAlbumInfo>();
  let offset = 0;

  while (true) {
    const result = await apiCall(
      () =>
        api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          50,
          offset,
        ),
      `editorial playlist ${playlistId}`,
    );
    if (!result.success) {
      if (result.authError) throw result.error;
      break;
    }

    for (const item of result.data.items) {
      if (item.track?.album) {
        const albumId = item.track.album.id;
        if (!albums.has(albumId)) {
          albums.set(albumId, {
            id: albumId,
            name: item.track.album.name,
            artistName:
              (item.track as unknown as { artists?: Array<{ name: string }> })
                .artists?.[0]?.name ?? "Unknown",
          });
        }
      }
    }
    if (result.data.items.length < 50) break;
    offset += 50;
    if (offset > maxOffset) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return albums;
}

/** Scan playlist tracks with position info for recency calculations. */
export async function getPlaylistTracksWithPositions(
  api: SpotifyApi,
  playlistId: string,
  apiCall: ApiCallFn,
): Promise<{ artistData: Map<string, { positions: number[]; trackCount: number; id: string | null }>; totalTracks: number }> {
  const artistData = new Map<string, { positions: number[]; trackCount: number; id: string | null }>();
  let offset = 0;
  const limit = 50;
  let position = 0;
  let totalTracks = 0;

  while (true) {
    const result = await apiCall(
      () =>
        api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks with positions ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      break;
    }

    if (offset === 0) {
      totalTracks = result.data.total;
    }

    for (const item of result.data.items) {
      if (item.track?.artists) {
        for (const artist of item.track.artists as Array<{ id: string; name: string }>) {
          const name = artist.name;
          if (!artistData.has(name)) {
            artistData.set(name, { positions: [], trackCount: 0, id: artist.id });
          }
          const data = artistData.get(name)!;
          data.positions.push(position);
          data.trackCount++;
        }
      }
      position++;
    }

    if (result.data.items.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 30));
  }

  return { artistData, totalTracks };
}
