import type {
  PlaylistItem,
  PlaylistRead,
  PlaylistReads,
} from '../../lib/playlist-reads/index.js';
import type { SimplePlaylist } from '../../lib/types.js';
import type { PlaylistWrites } from '../../services/promotion-sync/index.js';
import type { WeeklyPlaylistStore } from '../../services/weekly-playlists/index.js';

// ── In-memory playlists (ADR-0013) ───────────────────────────────────────────
// One set of the user's playlists behind every port that reads or writes
// them: playlist reads, the weekly playlist store and promotion sync's
// writes. Each playlist's snapshot changes on every write or outside `edit`,
// the way Spotify's does, and a read is `cached` when the playlist hasn't
// moved since it was last read. Caching rules themselves (torn reads,
// datasets, Liked Songs keys) are playlist reads' own suite's concern.

/** A track by id, or with the artist and album fields a reader needs. */
export type MemoryTrack =
  | string
  | { id: string; name?: string; artistNames?: string[]; albumId?: string };

export interface MemoryPlaylist {
  id: string;
  /** A named playlist is the user's own, in the store's listing. */
  name?: string;
  tracks?: MemoryTrack[];
  /** With no `tracks`: that many placeholder tracks, `<id>-t1`, `<id>-t2`… */
  trackCount?: number;
}

/** The id `likedSongs()` reads. */
export const LIKED_SONGS = 'liked-songs';

export interface MemoryPlaylists {
  reads: PlaylistReads;
  store: WeeklyPlaylistStore;
  writes: PlaylistWrites;
  /** Playlists the store created, in order. */
  created: SimplePlaylist[];
  /** Track ids added per playlist, by the store or the writes. */
  added: Map<string, string[]>;
  /** Track ids removed per playlist. */
  removed: Map<string, string[]>;
  /** Each playlist whose items were fetched (not cached), in order. */
  trackReads: string[];
  /** Set to make every add throw. */
  failAddWith?: Error;
  /** A change made outside the app: replaces the tracks, moves the snapshot. */
  edit(playlistId: string, tracks: MemoryTrack[]): void;
  /** The playlist's next read comes back `missing` items short. */
  short(playlistId: string, missing: number): void;
  /** The playlist's next read fails with `error`. */
  fail(playlistId: string, error: Error): void;
  /** The playlist's current track ids. */
  trackIds(playlistId: string): string[];
}

interface Held {
  name?: string;
  tracks: Exclude<MemoryTrack, string>[];
  version: number;
}

const toTrack = (t: MemoryTrack) => (typeof t === 'string' ? { id: t } : t);

function itemOf(t: Exclude<MemoryTrack, string>): PlaylistItem {
  return {
    track: {
      id: t.id,
      name: t.name ?? t.id,
      durationMs: 0,
      artists: (t.artistNames ?? []).map((name) => ({ id: null, name })),
      album: {
        id: t.albumId ?? '',
        name: '',
        releaseDate: '',
        artistNames: [],
      },
    },
    uri: `spotify:track:${t.id}`,
    addedAt: null,
  };
}

/**
 * `calls` receives `create <name>` and `add <id>` in order, so a test can
 * check ordering against other ports that share it.
 */
export function memoryPlaylists(
  seed: MemoryPlaylist[] = [],
  calls: string[] = [],
): MemoryPlaylists {
  const playlists = new Map<string, Held>();
  const order: string[] = [];
  const put = (id: string, held: Held) => {
    if (!playlists.has(id)) order.push(id);
    playlists.set(id, held);
  };
  for (const p of seed) {
    const tracks = p.tracks
      ? p.tracks.map(toTrack)
      : Array.from({ length: p.trackCount ?? 0 }, (_, i) => ({
          id: `${p.id}-t${i + 1}`,
        }));
    put(p.id, { name: p.name, tracks, version: 0 });
  }
  const playlist = (id: string): Held => {
    let held = playlists.get(id);
    if (!held) {
      held = { tracks: [], version: 0 };
      put(id, held);
    }
    return held;
  };
  const snapshot = (id: string) => `${id}@${playlist(id).version}`;
  const change = (id: string, tracks: Exclude<MemoryTrack, string>[]) => {
    const held = playlist(id);
    held.tracks = tracks;
    held.version++;
  };

  /** The version each playlist was last read at, as playlist reads holds it. */
  const readAt = new Map<string, number>();
  const shortBy = new Map<string, number>();
  const failWith = new Map<string, Error>();

  const read = async (
    id: string,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<PlaylistRead> => {
    const failure = failWith.get(id);
    if (failure) {
      failWith.delete(id);
      return { success: false, error: failure, kind: 'unknown' };
    }
    const held = playlist(id);
    const items = held.tracks.map(itemOf);
    const missing = shortBy.get(id) ?? 0;
    shortBy.delete(id);
    if (missing === 0 && readAt.get(id) === held.version) {
      return {
        success: true,
        items,
        snapshot: snapshot(id),
        cached: true,
        missing: 0,
      };
    }
    fixture.trackReads.push(id);
    onProgress?.(items.length, items.length);
    // Like playlist reads: a short read is returned but never held.
    if (missing === 0) readAt.set(id, held.version);
    return {
      success: true,
      items: items.slice(0, Math.max(0, items.length - missing)),
      snapshot: snapshot(id),
      cached: false,
      missing,
    };
  };

  const addTracks = async (playlistId: string, trackIds: string[]) => {
    calls.push(`add ${playlistId}`);
    if (fixture.failAddWith) throw fixture.failAddWith;
    fixture.added.set(playlistId, [
      ...(fixture.added.get(playlistId) ?? []),
      ...trackIds,
    ]);
    change(playlistId, [
      ...playlist(playlistId).tracks,
      ...trackIds.map((id) => ({ id })),
    ]);
  };

  const fixture: MemoryPlaylists = {
    created: [],
    added: new Map(),
    removed: new Map(),
    trackReads: [],
    reads: {
      tracks: (id, opts = {}) => read(id, opts.onProgress),
      likedSongs: (opts = {}) => read(LIKED_SONGS, opts.onProgress),
    },
    store: {
      async list(_userId, onProgress) {
        const listed = order.filter((id) => playlists.get(id)?.name);
        onProgress?.(listed.length, listed.length);
        return listed.map((id) => {
          const held = playlist(id);
          return {
            id,
            name: held.name as string,
            trackCount: held.tracks.length,
            snapshotId: snapshot(id),
          };
        });
      },
      async create(_userId, name) {
        const id = `pl-${fixture.created.length + 1}`;
        put(id, { name, tracks: [], version: 0 });
        fixture.created.push({ id, name, trackCount: 0 });
        calls.push(`create ${name}`);
        return { id, url: `https://open.spotify.com/playlist/${id}` };
      },
      addTracks,
    },
    writes: {
      addTracks,
      async removeTracks(playlistId, trackIds) {
        fixture.removed.set(playlistId, [
          ...(fixture.removed.get(playlistId) ?? []),
          ...trackIds,
        ]);
        change(
          playlistId,
          playlist(playlistId).tracks.filter((t) => !trackIds.includes(t.id)),
        );
      },
    },
    edit(playlistId, tracks) {
      change(playlistId, tracks.map(toTrack));
    },
    short(playlistId, missing) {
      shortBy.set(playlistId, missing);
    },
    fail(playlistId, error) {
      failWith.set(playlistId, error);
    },
    trackIds(playlistId) {
      return playlist(playlistId).tracks.map((t) => t.id);
    },
  };
  return fixture;
}
