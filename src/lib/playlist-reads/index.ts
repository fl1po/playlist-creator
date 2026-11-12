import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { FailureKind, SpotifyGateway } from '../spotify/gateway.js';
import {
  LIKED_SONGS_TRACKS,
  PLAYLIST_TRACKS,
  type StoredPlaylistTracks,
  type UserData,
} from '../user-data/index.js';

/*
 * Playlist reads (ADR-0011): every read of a user's playlist tracks, and of
 * Liked Songs, goes through here. A read checks the playlist's live snapshot
 * with one call and reuses the tracks it holds for that snapshot, in memory
 * for as long as the user's data is open and in the PLAYLIST_TRACKS /
 * LIKED_SONGS_TRACKS datasets between runs. Nothing ever invalidates it: any
 * edit, by the app or anyone else, changes the snapshot.
 */

// ── Interface ────────────────────────────────────────────────────────────────

export interface PlaylistArtist {
  id: string | null;
  name: string;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  durationMs: number;
  artists: PlaylistArtist[];
  album: {
    id: string;
    name: string;
    releaseDate: string;
    artistNames: string[];
  };
}

/**
 * One slot of a playlist, in playlist order. `track` is null for a local
 * file, an episode or a track Spotify no longer has; the slot is kept so
 * positions count it, and `uri` is set whenever Spotify gave one.
 */
export interface PlaylistItem {
  track: PlaylistTrack | null;
  uri: string | null;
  addedAt: string | null;
}

/**
 * A complete read, or a failure; never a partial playlist. `snapshot` is the
 * snapshot the items are known to belong to, or null when Spotify couldn't
 * say (such a read is never stored). `cached` says no item page was fetched.
 */
export type PlaylistRead =
  | {
      success: true;
      items: PlaylistItem[];
      snapshot: string | null;
      cached: boolean;
    }
  | { success: false; error: Error; kind: FailureKind };

export interface PlaylistReadOpts {
  /**
   * A snapshot id the caller already holds (e.g. from the user's playlist
   * listing). Skips the live snapshot check.
   */
  snapshot?: string;
  /** Liveness while item pages are fetched. */
  onProgress?: (fetched: number, total: number) => void;
}

export interface PlaylistReads {
  /** A playlist's items, in playlist order. */
  tracks(playlistId: string, opts?: PlaylistReadOpts): Promise<PlaylistRead>;
  /**
   * Liked Songs, newest first, keyed by `total:newest added_at`. When that
   * key moves, only the new likes are fetched, unless the count shows
   * something else changed too, which costs a full read.
   */
  likedSongs(opts?: Omit<PlaylistReadOpts, 'snapshot'>): Promise<PlaylistRead>;
}

/** A read's items, or its failure thrown, for callers that can't go on without them. */
export function itemsOf(read: PlaylistRead): PlaylistItem[] {
  if (!read.success) throw read.error;
  return read.items;
}

/**
 * The session's playlist reads over its gateway. Everything held is shared by
 * every playlist reads built over the same `data` (a route's and a task's
 * views of one user), so building one is free.
 */
export function playlistReads(session: {
  gateway: SpotifyGateway;
  data: UserData;
}): PlaylistReads {
  const { gateway, data } = session;
  const memory = memoryFor(data);

  return {
    async tracks(playlistId, opts = {}) {
      const snapshot =
        opts.snapshot ?? (await playlistSnapshot(gateway, playlistId));
      if (snapshot === null) {
        // Unknown snapshot: read in full, store nothing.
        const read = await fetchItems(gateway, playlistPages(playlistId), opts);
        return read.success
          ? { success: true, items: read.items, snapshot: null, cached: false }
          : read;
      }

      const hit = await memory.playlist(playlistId, snapshot);
      if (hit) return { success: true, items: hit, snapshot, cached: true };

      return memory.once(
        `${playlistId}\0${snapshot}`,
        opts,
        async (onProgress) => {
          const read = await fetchItems(gateway, playlistPages(playlistId), {
            onProgress,
          });
          if (!read.success) return read;
          // Store only when the playlist didn't move while it was read.
          const after = await playlistSnapshot(gateway, playlistId);
          if (after !== snapshot)
            return {
              success: true,
              items: read.items,
              snapshot: null,
              cached: false,
            };
          await memory.storePlaylist(playlistId, snapshot, read.items);
          return { success: true, items: read.items, snapshot, cached: false };
        },
      );
    },

    async likedSongs(opts = {}) {
      const key = await likedSongsKey(gateway);
      const held = await memory.liked();
      if (key !== null && held?.snapshot === key)
        return {
          success: true,
          items: held.items,
          snapshot: key,
          cached: true,
        };

      return memory.once(`liked\0${key}`, opts, async (onProgress) => {
        const newest = held?.items[0];
        const read = await fetchItems(gateway, LIKED_PAGES, {
          onProgress,
          stopAt: newest ? (item) => sameItem(item, newest) : undefined,
        });
        if (!read.success) return read;

        let items = read.items;
        if (read.stopped && held) {
          // The new likes, then what was held, if the count adds up.
          if (items.length + held.items.length === read.total) {
            items = [...items, ...held.items];
          } else {
            const full = await fetchItems(gateway, LIKED_PAGES, { onProgress });
            if (!full.success) return full;
            items = full.items;
          }
        }

        if (key === null)
          return { success: true, items, snapshot: null, cached: false };
        const after = await likedSongsKey(gateway);
        if (after !== key)
          return { success: true, items, snapshot: null, cached: false };
        await memory.storeLiked(key, items);
        return { success: true, items, snapshot: key, cached: false };
      });
    },
  };
}

/** Entries nobody has read for this long leave PLAYLIST_TRACKS. */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A cache hit re-saves its `readAt` at most this often. */
const TOUCH_EVERY_MS = 24 * 60 * 60 * 1000;

// ── Spotify reads ────────────────────────────────────────────────────────────

const PAGE = 50;
const ITEM_FIELDS =
  'total,items(added_at,track(id,uri,name,type,is_local,duration_ms,artists(id,name),album(id,name,release_date,artists(name))))';

interface PageSource {
  fetch(api: SpotifyApi, limit: number, offset: number): Promise<unknown>;
  description: string;
}

function playlistPages(playlistId: string): PageSource {
  return {
    fetch: (api, limit, offset) =>
      api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        ITEM_FIELDS,
        limit as never,
        offset,
      ),
    description: `playlist items ${playlistId}`,
  };
}

const LIKED_PAGES: PageSource = {
  fetch: (api, limit, offset) =>
    api.currentUser.tracks.savedTracks(limit as never, offset),
  description: 'liked songs',
};

async function playlistSnapshot(
  gateway: SpotifyGateway,
  playlistId: string,
): Promise<string | null> {
  const r = await gateway.call(
    (api) => api.playlists.getPlaylist(playlistId, undefined, 'snapshot_id'),
    `playlist snapshot ${playlistId}`,
  );
  return r.success ? (r.data.snapshot_id ?? null) : null;
}

/** Liked Songs' stand-in for a snapshot id: total count + newest addition. */
async function likedSongsKey(gateway: SpotifyGateway): Promise<string | null> {
  const r = await gateway.call(
    (api) => api.currentUser.tracks.savedTracks(1, 0),
    'liked songs snapshot',
  );
  if (!r.success) return null;
  const page = r.data as {
    total?: number;
    items?: Array<{ added_at?: string }>;
  };
  return `${page.total ?? 0}:${page.items?.[0]?.added_at ?? ''}`;
}

type Fetched =
  | { success: true; items: PlaylistItem[]; total: number; stopped: boolean }
  | { success: false; error: Error; kind: FailureKind };

/**
 * Every page, or a failure. With `stopAt`, stops before the first item it
 * matches (`stopped: true`); the items before it come back.
 */
async function fetchItems(
  gateway: SpotifyGateway,
  source: PageSource,
  opts: {
    onProgress?: (fetched: number, total: number) => void;
    stopAt?: (item: PlaylistItem) => boolean;
  },
): Promise<Fetched> {
  const items: PlaylistItem[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    gateway.signal?.throwIfAborted();
    const result = await gateway.call(
      (api) => source.fetch(api, PAGE, offset),
      source.description,
    );
    if (!result.success)
      return { success: false, error: result.error, kind: result.kind };

    const page = result.data as { items?: unknown[]; total?: number };
    if (offset === 0) total = page.total ?? 0;
    const raw = page.items ?? [];
    for (const r of raw) {
      const item = fromSpotify(r);
      if (opts.stopAt?.(item))
        return { success: true, items, total, stopped: true };
      items.push(item);
    }
    offset += raw.length;
    opts.onProgress?.(offset, total);
    if (raw.length < PAGE) break;
  }
  return { success: true, items, total, stopped: false };
}

function sameItem(a: PlaylistItem, b: PlaylistItem): boolean {
  return a.uri === b.uri && a.addedAt === b.addedAt;
}

function fromSpotify(raw: any): PlaylistItem {
  const t = raw?.track;
  const addedAt: string | null = raw?.added_at ?? null;
  if (!t) return { track: null, uri: null, addedAt };
  if (!t.id || t.is_local || (t.type && t.type !== 'track'))
    return { track: null, uri: t.uri ?? null, addedAt };
  return {
    track: {
      id: t.id,
      name: t.name ?? '',
      durationMs: t.duration_ms ?? 0,
      artists: (t.artists ?? []).map((a: { id?: string; name?: string }) => ({
        id: a.id ?? null,
        name: a.name ?? '',
      })),
      album: {
        id: t.album?.id ?? '',
        name: t.album?.name ?? '',
        releaseDate: t.album?.release_date ?? '',
        artistNames: (t.album?.artists ?? []).map(
          (a: { name?: string }) => a.name ?? '',
        ),
      },
    },
    uri: `spotify:track:${t.id}`,
    addedAt,
  };
}

// ── Stored encoding ──────────────────────────────────────────────────────────
// Short keys keep Liked Songs' ~13k items small; a track's uri is its id.

interface Encoded {
  /** track id */
  i?: string;
  /** track name */
  n?: string;
  /** duration ms */
  d?: number;
  /** artists: [id, name] */
  a?: Array<[string | null, string]>;
  /** album: [id, name, release date, artist names] */
  b?: [string, string, string, string[]];
  /** added_at */
  t?: string;
  /** uri of a slot without a track */
  u?: string;
}

export function encodeItem(item: PlaylistItem): Encoded {
  const e: Encoded = {};
  if (item.track) {
    const { track } = item;
    e.i = track.id;
    e.n = track.name;
    e.d = track.durationMs;
    e.a = track.artists.map((a) => [a.id, a.name]);
    e.b = [
      track.album.id,
      track.album.name,
      track.album.releaseDate,
      track.album.artistNames,
    ];
  } else if (item.uri) {
    e.u = item.uri;
  }
  if (item.addedAt) e.t = item.addedAt;
  return e;
}

export function decodeItem(e: Encoded): PlaylistItem {
  const addedAt = e.t ?? null;
  if (!e.i) return { track: null, uri: e.u ?? null, addedAt };
  const [albumId, albumName, releaseDate, albumArtists] = e.b ?? [
    '',
    '',
    '',
    [],
  ];
  return {
    track: {
      id: e.i,
      name: e.n ?? '',
      durationMs: e.d ?? 0,
      artists: (e.a ?? []).map(([id, name]) => ({ id, name })),
      album: {
        id: albumId,
        name: albumName,
        releaseDate,
        artistNames: albumArtists,
      },
    },
    uri: `spotify:track:${e.i}`,
    addedAt,
  };
}

// ── Memory, shared per user data ─────────────────────────────────────────────

type Progress = (fetched: number, total: number) => void;

/** A caller sharing a read with an `onProgress`; failed alone if it throws. */
interface Listener {
  onProgress: Progress;
  fail: (error: unknown) => void;
}

interface Inflight {
  read: Promise<PlaylistRead>;
  /** Callers on the read, listening or not; the read stops at zero. */
  waiting: number;
  listeners: Set<Listener>;
  lastProgress: [number, number] | null;
}

interface Held {
  snapshot: string;
  items: PlaylistItem[];
}

interface Memory {
  playlist(
    playlistId: string,
    snapshot: string,
  ): Promise<PlaylistItem[] | null>;
  storePlaylist(
    playlistId: string,
    snapshot: string,
    items: PlaylistItem[],
  ): Promise<void>;
  liked(): Promise<Held | null>;
  storeLiked(key: string, items: PlaylistItem[]): Promise<void>;
  /**
   * Run `fn` once per key at a time; concurrent callers share its result and
   * its progress, a late caller first hearing where the read already is. A
   * caller whose `onProgress` throws fails alone with that error; the read
   * stops only once no caller is left on it.
   */
  once(
    key: string,
    opts: { onProgress?: Progress },
    fn: (onProgress: Progress) => Promise<PlaylistRead>,
  ): Promise<PlaylistRead>;
}

/** Tells one listener; one that throws leaves the read, failed with its error. */
function tell(
  entry: Inflight,
  listener: Listener,
  fetched: number,
  total: number,
): { thrown: unknown } | null {
  try {
    listener.onProgress(fetched, total);
    return null;
  } catch (thrown) {
    entry.listeners.delete(listener);
    entry.waiting--;
    listener.fail(thrown);
    return { thrown };
  }
}

const memories = new WeakMap<UserData, Memory>();

function memoryFor(data: UserData): Memory {
  let memory = memories.get(data);
  if (!memory) {
    memory = createMemory(data, () => Date.now());
    memories.set(data, memory);
  }
  return memory;
}

function createMemory(data: UserData, now: () => number): Memory {
  let stored: Promise<Record<string, StoredPlaylistTracks>> | null = null;
  const decoded = new Map<string, Held>();
  let liked: Promise<Held | null> | null = null;
  const inflight = new Map<string, Inflight>();

  const playlists = () => {
    stored ??= data.load(PLAYLIST_TRACKS).then((v) => v ?? {});
    return stored;
  };

  async function savePlaylists(all: Record<string, StoredPlaylistTracks>) {
    const cutoff = now() - PRUNE_AFTER_MS;
    for (const [id, entry] of Object.entries(all)) {
      if (entry.readAt < cutoff) {
        delete all[id];
        decoded.delete(id);
      }
    }
    await data.save(PLAYLIST_TRACKS, all);
  }

  return {
    async playlist(playlistId, snapshot) {
      const all = await playlists();
      const entry = all[playlistId];
      if (!entry || entry.snapshot !== snapshot) return null;
      let held = decoded.get(playlistId);
      if (!held || held.snapshot !== snapshot) {
        held = { snapshot, items: (entry.items as Encoded[]).map(decodeItem) };
        decoded.set(playlistId, held);
      }
      if (now() - entry.readAt > TOUCH_EVERY_MS) {
        entry.readAt = now();
        await savePlaylists(all);
      }
      return held.items;
    },

    async storePlaylist(playlistId, snapshot, items) {
      const all = await playlists();
      all[playlistId] = {
        snapshot,
        readAt: now(),
        items: items.map(encodeItem),
      };
      decoded.set(playlistId, { snapshot, items });
      await savePlaylists(all);
    },

    liked() {
      liked ??= data.load(LIKED_SONGS_TRACKS).then((v) =>
        v
          ? {
              snapshot: v.snapshot,
              items: (v.items as Encoded[]).map(decodeItem),
            }
          : null,
      );
      return liked;
    },

    async storeLiked(key, items) {
      liked = Promise.resolve({ snapshot: key, items });
      await data.save(LIKED_SONGS_TRACKS, {
        snapshot: key,
        readAt: now(),
        items: items.map(encodeItem),
      });
    },

    once(key, { onProgress }, fn) {
      let running = inflight.get(key);
      if (!running) {
        const entry: Inflight = {
          read: null as never,
          waiting: 0,
          listeners: new Set(),
          lastProgress: null,
        };
        entry.read = fn((fetched, total) => {
          entry.lastProgress = [fetched, total];
          for (const listener of [...entry.listeners]) {
            const left = tell(entry, listener, fetched, total);
            // Throwing here ends the fetch: worth it only once nobody wants the items.
            if (left && entry.waiting === 0) throw left.thrown;
          }
        }).finally(() => inflight.delete(key));
        inflight.set(key, entry);
        running = entry;
      }
      const entry = running;
      entry.waiting++;
      // A promise per caller, so one caller can fail without failing the rest.
      return new Promise<PlaylistRead>((resolve, reject) => {
        entry.read.then(resolve, reject);
        if (!onProgress) return;
        const listener: Listener = { onProgress, fail: reject };
        entry.listeners.add(listener);
        if (entry.lastProgress) tell(entry, listener, ...entry.lastProgress);
      });
    },
  };
}
