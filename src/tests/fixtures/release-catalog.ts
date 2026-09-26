import type { PlaylistTrackWithArtists } from '../../lib/pagination.js';
import type { AlbumTrack, PlaylistAlbumInfo } from '../../lib/types.js';
import type {
  PlaylistWrites,
  PromotionReads,
} from '../../services/promotion-sync/index.js';
import type { ArtistProfile } from '../../services/week-collection/index.js';

// ── Fixture catalog ──────────────────────────────────────────────────────────
// An in-memory Spotify: artists with their albums, optional editorial
// playlist contents, artist profiles, and weekly playlists. One adapter
// satisfies both ReleaseReads (week collection, fill) and PromotionReads
// (promotion sync), so every module that shares the release engine shares
// this fixture too.

export interface FixtureAlbum {
  id: string;
  name: string;
  type: string;
  release_date: string;
  markets?: number;
  explicit?: boolean;
  tracks: AlbumTrack[];
}

export interface FixtureArtist {
  id: string;
  name: string;
  albums: FixtureAlbum[];
}

export interface FixturePlaylistTrack {
  id: string;
  name: string;
  artistNames: string[];
  albumId?: string;
}

export interface FixturePlaylist {
  id: string;
  name: string;
  tracks: FixturePlaylistTrack[];
}

export interface Catalog {
  artists: FixtureArtist[];
  /** Editorial playlist id → the albums it contains. */
  playlistAlbums?: Record<string, PlaylistAlbumInfo[]>;
  /** Artist id → profile, for the editorial gate. */
  profiles?: Record<string, ArtistProfile>;
  /** Weekly playlists with their tracks, for promotion sync's two reads. */
  playlists?: FixturePlaylist[];
}

export function fixtureReads(catalog: Catalog): PromotionReads & {
  searchCalls: string[];
} {
  const findAlbum = (albumId: string) => {
    for (const artist of catalog.artists) {
      const album = artist.albums.find((a) => a.id === albumId);
      if (album) return { artist, album };
    }
    return null;
  };
  const playlist = (id: string) =>
    catalog.playlists?.find((p) => p.id === id) ?? null;

  return {
    searchCalls: [],
    async searchArtist(name) {
      this.searchCalls.push(name);
      const artist = catalog.artists.find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      return artist ? { id: artist.id, name: artist.name } : null;
    },
    async artistAlbums(artistId) {
      const artist = catalog.artists.find((a) => a.id === artistId);
      return (artist?.albums ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        release_date: a.release_date,
        markets: a.markets ?? 0,
      }));
    },
    async albumDetails(albumId) {
      const hit = findAlbum(albumId);
      if (!hit) return null;
      return {
        id: hit.album.id,
        name: hit.album.name,
        type: hit.album.type,
        release_date: hit.album.release_date,
        explicit: hit.album.explicit ?? false,
        markets: hit.album.markets ?? 0,
        artists: [{ id: hit.artist.id, name: hit.artist.name }],
      };
    },
    async albumTracks(albumId) {
      return findAlbum(albumId)?.album.tracks ?? [];
    },
    async playlistAlbums(playlistId) {
      const infos = catalog.playlistAlbums?.[playlistId] ?? [];
      return new Map(infos.map((i) => [i.id, i]));
    },
    async userPlaylists() {
      return [];
    },
    async artistProfile(artistId) {
      return catalog.profiles?.[artistId] ?? null;
    },
    async playlistTracksWithArtists(playlistId) {
      const pl = playlist(playlistId);
      return (pl?.tracks ?? []).map(
        (t): PlaylistTrackWithArtists => ({
          uri: `spotify:track:${t.id}`,
          id: t.id,
          name: t.name,
          artistNames: t.artistNames,
          albumId: t.albumId ?? '',
        }),
      );
    },
    async playlistTrackIds(playlistId) {
      return (playlist(playlistId)?.tracks ?? []).map((t) => t.id);
    },
  };
}

// ── Recording PlaylistWrites ─────────────────────────────────────────────────

export interface RecordingWrites extends PlaylistWrites {
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
}

export function recordingWrites(): RecordingWrites {
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  return {
    added,
    removed,
    async addTracks(playlistId, trackIds) {
      added.set(playlistId, [...(added.get(playlistId) ?? []), ...trackIds]);
    },
    async removeTracks(playlistId, trackIds) {
      removed.set(playlistId, [
        ...(removed.get(playlistId) ?? []),
        ...trackIds,
      ]);
    },
  };
}
