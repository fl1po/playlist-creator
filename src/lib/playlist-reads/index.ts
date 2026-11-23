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
 *
 * Items are paged by offset, so an edit during a read shifts the pages under
 * it: tracks are skipped or read twice. A read counts only if the snapshot is
 * the same after it as before; otherwise it is made once more, then fails.
 * Spotify can also leave items out of a page of a playlist nobody touched. A
 * read short of Spotify's total is made once more too; if it is short again,
 * it is returned with how many items are missing, and not stored.
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
 * A read of one snapshot, or a failure; never one torn by an edit.
 * `snapshot` is the snapshot the items belong to. `cached` says no item page
 * was fetched. `missing` is how many items Spotify counted in its total but
 * didn't return; such a read is never stored.
 */
export type PlaylistRead =
  | {
      success: true;
      items: PlaylistItem[];
      snapshot: string;
      cached: boolean;
      missing: number;
    }
  | { success: false; error: Error; kind: FailureKind };

export interface PlaylistReadOpts {
  /**
   * A snapshot id the caller already holds (e.g. from the user's playlist
   * listing). Skips the live snapshot check when the tracks for it are held;
   * otherwise the live snapshot is checked before reading.
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

/** Every track id on a read playlist, in order; throws if the read failed. */
export function trackIdsOf(read: PlaylistRead): string[] {
  return itemsOf(read).flatMap((i) => (i.track ? [i.track.id] : []));
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
      if (opts.snapshot) {
        const snapshot = opts.snapshot;
        const hit = await memory.playlist(playlistId, snapshot);
        if (hit)
          return {
            success: true,
            items: hit,
            snapshot,
            cached: true,
            missing: 0,
          };
      }
      return attempts(async () => {
        const snap = await playlistSnapshot(gateway, playlistId);
        if (!snap.success) return snap;
        const { snapshot } = snap;

        const hit = await memory.playlist(playlistId, snapshot);
        if (hit)
          return {
            success: true,
            items: hit,
            snapshot,
            cached: true,
            missing: 0,
          };

        return memory.once(
          `${playlistId}\0${snapshot}`,
          { gateway, onProgress: opts.onProgress },
          // The shared gateway, not this caller's: the read outlives its stop.
          async ({ gateway, onProgress }): Promise<Attempt> => {
            const read = await fetchItems(gateway, playlistPages(playlistId), {
              onProgress,
            });
            if (!read.success) return read;
            const after = await playlistSnapshot(gateway, playlistId);
            if (!after.success) return after;
            if (after.snapshot !== snapshot) return moved(playlistId);
            const missing = read.lastTotal - read.items.length;
            const result = {
              success: true as const,
              items: read.items,
              snapshot,
              cached: false,
              missing,
            };
            if (missing !== 0) return shortRead(result, read.lastTotal);
            await memory.storePlaylist(playlistId, snapshot, read.items);
            return result;
          },
        );
      });
    },

    async likedSongs(opts = {}) {
      return attempts(async () => {
        const keyed = await likedSongsKey(gateway);
        if (!keyed.success) return keyed;
        const { key } = keyed;
        const held = await memory.liked();
        if (held?.snapshot === key)
          return {
            success: true,
            items: held.items,
            snapshot: key,
            cached: true,
            missing: 0,
          };

        return memory.once(
          `liked\0${key}`,
          { gateway, onProgress: opts.onProgress },
          async ({ gateway, onProgress }): Promise<Attempt> => {
            const newest = held?.items[0];
            const read = await fetchItems(gateway, LIKED_PAGES, {
              onProgress,
              stopAt: newest ? (item) => sameItem(item, newest) : undefined,
            });
            if (!read.success) return read;

            let items = read.items;
            let total = read.lastTotal;
            if (read.stopped && held) {
              // The new likes, then what was held, if the count adds up.
              if (items.length + held.items.length === read.total) {
                items = [...items, ...held.items];
              } else {
                const full = await fetchItems(gateway, LIKED_PAGES, {
                  onProgress,
                });
                if (!full.success) return full;
                items = full.items;
                total = full.lastTotal;
              }
            }

            const after = await likedSongsKey(gateway);
            if (!after.success) return after;
            if (after.key !== key) return moved('Liked Songs');
            const result = {
              success: true as const,
              items,
              snapshot: key,
              cached: false,
              missing: total - items.length,
            };
            if (result.missing !== 0) return shortRead(result, total);
            await memory.storeLiked(key, items);
            return result;
          },
        );
      });
    },
  };
}

// ── Attempts ─────────────────────────────────────────────────────────────────

/**
 * A read that didn't add up, made again once. If the second one doesn't
 * either, it fails with `retry`, or, when one of one snapshot came back
 * short of Spotify's total, that is what Spotify has: `short` is returned.
 */
interface Retry {
  retry: Error;
  short?: PlaylistRead;
}

type Attempt = PlaylistRead | Retry;

const moved = (what: string): Retry => ({
  retry: new Error(`${what} changed while it was read`),
});

const shortRead = (
  read: PlaylistRead & { success: true },
  total: number,
): Retry => ({
  retry: new Error(`Spotify returned ${read.items.length} of ${total} items`),
  short: read,
});

/** Runs `attempt` until it adds up, at most twice. */
async function attempts(
  attempt: () => Promise<Attempt>,
): Promise<PlaylistRead> {
  let last: Retry | null = null;
  for (let i = 0; i < 2; i++) {
    const result = await attempt();
    if (!('retry' in result)) return result;
    last = result;
  }
  const { retry, short } = last as Retry;
  return short ?? { success: false, error: retry, kind: 'unknown' };
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

type Failure = { success: false; error: Error; kind: FailureKind };

async function playlistSnapshot(
  gateway: SpotifyGateway,
  playlistId: string,
): Promise<{ success: true; snapshot: string } | Failure> {
  const r = await gateway.call(
    (api) => api.playlists.getPlaylist(playlistId, undefined, 'snapshot_id'),
    `playlist snapshot ${playlistId}`,
  );
  if (!r.success) return { success: false, error: r.error, kind: r.kind };
  if (!r.data.snapshot_id)
    return {
      success: false,
      error: new Error(`Spotify gave no snapshot for playlist ${playlistId}`),
      kind: 'unknown',
    };
  return { success: true, snapshot: r.data.snapshot_id };
}

/** Liked Songs' stand-in for a snapshot id: total count + newest addition. */
async function likedSongsKey(
  gateway: SpotifyGateway,
): Promise<{ success: true; key: string } | Failure> {
  const r = await gateway.call(
    (api) => api.currentUser.tracks.savedTracks(1, 0),
    'liked songs snapshot',
  );
  if (!r.success) return { success: false, error: r.error, kind: r.kind };
  const page = r.data as {
    total?: number;
    items?: Array<{ added_at?: string }>;
  };
  return {
    success: true,
    key: `${page.total ?? 0}:${page.items?.[0]?.added_at ?? ''}`,
  };
}

/**
 * `total` is what the first page said; `lastTotal` what the last one did. A
 * read the playlist held still for, with nothing left out, has exactly
 * `lastTotal` items.
 */
type Fetched =
  | {
      success: true;
      items: PlaylistItem[];
      total: number;
      lastTotal: number;
      stopped: boolean;
    }
  | Failure;

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
  let lastTotal = 0;
  while (true) {
    gateway.signal?.throwIfAborted();
    const result = await gateway.call(
      (api) => source.fetch(api, PAGE, offset),
      source.description,
    );
    if (!result.success)
      return { success: false, error: result.error, kind: result.kind };

    const page = result.data as { items?: unknown[]; total?: number };
    lastTotal = page.total ?? 0;
    if (offset === 0) total = lastTotal;
    const raw = page.items ?? [];
    for (const r of raw) {
      const item = fromSpotify(r);
      if (opts.stopAt?.(item))
        return { success: true, items, total, lastTotal, stopped: true };
      items.push(item);
    }
    // Spotify's positions: a page it left items out of still covers PAGE.
    offset += PAGE;
    opts.onProgress?.(Math.min(offset, total), total);
    if (raw.length === 0 || offset >= lastTotal) break;
  }
  return { success: true, items, total, lastTotal, stopped: false };
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

/** What a caller brings to a shared read: its gateway and its progress. */
interface Joining {
  gateway: SpotifyGateway;
  onProgress?: Progress;
}

/** A caller on a shared read; it leaves alone, failed with its own error. */
interface Caller extends Joining {
  fail: (error: unknown) => void;
}

interface Inflight {
  read: Promise<unknown>;
  /** Callers still on the read; the read stops once none is left. */
  callers: Set<Caller>;
  lastProgress: [number, number] | null;
  /** Aborted when the last caller leaves, with that caller's reason. */
  stop: AbortController;
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
   * caller that is stopped, or whose `onProgress` throws, leaves at once and
   * fails alone with that error; the read stops only once no caller is left.
   */
  once<T>(
    key: string,
    caller: Joining,
    fn: (shared: {
      gateway: SpotifyGateway;
      onProgress: Progress;
    }) => Promise<T>,
  ): Promise<T>;
}

/** Tells one caller its progress; what it throws, if anything. */
function tell(
  caller: Caller,
  fetched: number,
  total: number,
): { thrown: unknown } | null {
  try {
    caller.onProgress?.(fetched, total);
    return null;
  } catch (thrown) {
    return { thrown };
  }
}

/** Fails one caller alone; the last one to leave stops the read. */
function leave(entry: Inflight, caller: Caller, reason: unknown): void {
  if (!entry.callers.delete(caller)) return;
  caller.fail(reason);
  if (entry.callers.size === 0) entry.stop.abort(reason);
}

/**
 * The gateway a shared read runs on. Each call goes through the gateway of a
 * caller still on the read, so a stopped caller's signal can't end it for the
 * rest: a call it was carrying is made again through the next caller's.
 */
function sharedGateway(entry: Inflight): SpotifyGateway {
  return {
    signal: entry.stop.signal,
    async call(fn, description) {
      while (true) {
        entry.stop.signal.throwIfAborted();
        const [carrier] = entry.callers;
        try {
          return await carrier.gateway.call(fn, description);
        } catch (error) {
          if (carrier.gateway.signal?.aborted) continue;
          throw error;
        }
      }
    },
  };
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

    once<T>(
      key: string,
      { gateway, onProgress }: Joining,
      fn: (shared: {
        gateway: SpotifyGateway;
        onProgress: Progress;
      }) => Promise<T>,
    ): Promise<T> {
      const { signal } = gateway;
      // Turned away before starting a read it would leave with no caller.
      if (signal?.aborted) return Promise.reject(signal.reason);
      let entry = inflight.get(key);
      // A read everyone has left is only finishing; it takes no new callers.
      if (!entry || entry.stop.signal.aborted) {
        const started: Inflight = {
          read: null as never,
          callers: new Set(),
          lastProgress: null,
          stop: new AbortController(),
        };
        // Started a turn later, so the caller below is on the read first.
        started.read = Promise.resolve()
          .then(() =>
            fn({
              gateway: sharedGateway(started),
              onProgress: (fetched, total) => {
                started.lastProgress = [fetched, total];
                for (const caller of [...started.callers]) {
                  const told = tell(caller, fetched, total);
                  if (told) leave(started, caller, told.thrown);
                }
                // Ends the fetch once nobody is left to want the items.
                started.stop.signal.throwIfAborted();
              },
            }),
          )
          .finally(() => {
            if (inflight.get(key) === started) inflight.delete(key);
          });
        inflight.set(key, started);
        entry = started;
      }
      const joined = entry;
      // A promise per caller, so one caller can fail without failing the rest.
      return new Promise<T>((resolve, reject) => {
        const caller: Caller = { gateway, onProgress, fail: reject };
        const stopped = () => leave(joined, caller, signal?.reason);
        joined.callers.add(caller);
        signal?.addEventListener('abort', stopped, { once: true });
        (joined.read as Promise<T>)
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', stopped));
        if (!joined.lastProgress) return;
        const told = tell(caller, ...joined.lastProgress);
        if (told) leave(joined, caller, told.thrown);
      });
    },
  };
}
