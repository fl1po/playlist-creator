import { generateFridayDates, parseDate } from '../../domain/tracks.js';
import type { SimplePlaylist } from '../../lib/types.js';
import {
  type UserData,
  WEEKLY_PLAYLIST_TRACKS,
  type WeeklyPlaylistTrackIds,
} from '../../lib/user-data/index.js';

/**
 * Weekly playlists — the date-named (`DD.MM.YY`) playlists holding one
 * Friday's week collection each. This module owns what makes a playlist a
 * weekly playlist, which playlist is a date's, when a Friday counts as
 * unfilled, which are unprocessed, and the write itself: reuse the date's
 * empty playlist or create it, then add the tracks.
 */

// ── Ports (the seam) ─────────────────────────────────────────────────────────

/**
 * The playlist reads and writes a weekly playlist needs. Prod adapter wraps
 * SpotifyGateway + pagination; test adapter is an in-memory listing.
 *
 * Error contract: `create` and `addTracks` throw on any failure, auth
 * failures included (the fill re-auths and retries the date). A throw from
 * `addTracks` means the write must not be treated as done.
 */
export interface WeeklyPlaylistStore {
  /**
   * Every playlist the user owns, all pages, each with its `snapshotId` when
   * Spotify gives one. `onProgress` gets the running count of playlists read
   * (owned or not) against the total after each page.
   */
  list(
    userId: string,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<SimplePlaylist[]>;
  create(userId: string, name: string): Promise<{ id: string; url: string }>;
  addTracks(playlistId: string, trackIds: string[]): Promise<void>;
  /** Every track id on a playlist, all pages. */
  trackIds(playlistId: string): Promise<string[]>;
}

// ── Naming ───────────────────────────────────────────────────────────────────

const WEEKLY_NAME = /^\d{2}\.\d{2}\.\d{2}$/;

/** Whether a playlist name is a weekly playlist's `DD.MM.YY` date. */
export function isWeeklyPlaylistName(name: string): boolean {
  return WEEKLY_NAME.test(name);
}

/** The date's weekly playlist among `playlists`, or null. */
function weeklyPlaylistIn(
  playlists: SimplePlaylist[],
  date: string,
): SimplePlaylist | null {
  if (!isWeeklyPlaylistName(date)) return null;
  return playlists.find((p) => p.name === date) ?? null;
}

/** The first Friday a fill covers for a user with no weekly playlists yet. */
const DEFAULT_START = new Date(2025, 4, 23);

const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * The user's weekly playlist for `date`, or null when there is none: never
 * created, deleted, or renamed away from its date.
 */
export async function findWeeklyPlaylist(
  store: WeeklyPlaylistStore,
  userId: string,
  date: string,
): Promise<SimplePlaylist | null> {
  return weeklyPlaylistIn(await store.list(userId), date);
}

export interface WeeklyWrite {
  date: string;
  playlistId: string;
  playlistUrl: string;
  /** `skipped` when the date's playlist was already filled; nothing written. */
  outcome: 'created' | 'reused' | 'skipped';
  /** Tracks on the playlist as a result of this write. */
  tracksAdded: number;
}

export interface WeeklyPlaylists {
  /**
   * Fridays from the earliest weekly playlist (or the default start) up to
   * `until` that have no filled weekly playlist, oldest first.
   */
  unfilledFridays(until: Date): Promise<string[]>;
  /**
   * Write one Friday's tracks: reuse the date's empty playlist or create it,
   * then add the tracks. A filled playlist is left alone.
   */
  write(date: string, trackIds: string[]): Promise<WeeklyWrite>;
}

export interface WeeklyPlaylistsDeps {
  store: WeeklyPlaylistStore;
  userId: string;
  /** Progress of the one listing read, page by page. */
  onListProgress?: (fetched: number, total: number) => void;
}

/**
 * One user's weekly playlists for the duration of a fill. The listing is
 * read once and kept current with every playlist this instance creates or
 * fills, so later dates see earlier writes without re-reading Spotify.
 */
export function weeklyPlaylists(deps: WeeklyPlaylistsDeps): WeeklyPlaylists {
  const { store, userId } = deps;
  let weeklies: SimplePlaylist[] | null = null;
  const listing = async (): Promise<SimplePlaylist[]> => {
    if (!weeklies) {
      weeklies = (await store.list(userId, deps.onListProgress)).filter((p) =>
        isWeeklyPlaylistName(p.name),
      );
    }
    return weeklies;
  };

  return {
    async unfilledFridays(until) {
      const all = await listing();
      const filled = new Set(
        all.filter((p) => p.trackCount > 0).map((p) => p.name),
      );
      const start =
        all.length > 0
          ? new Date(Math.min(...all.map((p) => parseDate(p.name).getTime())))
          : DEFAULT_START;
      return generateFridayDates(start, until).filter((d) => !filled.has(d));
    },

    async write(date, trackIds) {
      const all = await listing();
      const existing = weeklyPlaylistIn(all, date);
      if (existing && existing.trackCount > 0) {
        return {
          date,
          playlistId: existing.id,
          playlistUrl: playlistUrl(existing.id),
          outcome: 'skipped',
          tracksAdded: existing.trackCount,
        };
      }

      let playlist: SimplePlaylist;
      let url: string;
      let outcome: WeeklyWrite['outcome'];
      if (existing) {
        playlist = existing;
        url = playlistUrl(existing.id);
        outcome = 'reused';
      } else {
        const created = await store.create(userId, date);
        playlist = { id: created.id, name: date, trackCount: 0 };
        url = created.url;
        outcome = 'created';
        all.push(playlist);
      }

      if (trackIds.length > 0) {
        await store.addTracks(playlist.id, trackIds);
        playlist.trackCount = trackIds.length;
      }

      return {
        date,
        playlistId: playlist.id,
        playlistUrl: url,
        outcome,
        tracksAdded: trackIds.length,
      };
    },
  };
}

// ── Unprocessed weekly playlists ─────────────────────────────────────────────

export interface UnprocessedWeeklyPlaylistsDeps {
  store: WeeklyPlaylistStore;
  /** Holds each walked playlist's track ids by snapshot between listings. */
  data: UserData;
  userId: string;
}

/**
 * The unprocessed weekly playlists, oldest first: every weekly playlist with
 * tracks that is newer than the newest one overlapping All Weekly. Anything
 * older than that cutoff is assumed listened.
 *
 * Always current, with nothing to invalidate: All Weekly and the playlist
 * listing are read fresh every time, and a playlist's tracks are reused only
 * while its Spotify snapshot is unchanged. Any edit to a playlist, by the app
 * or anyone else, makes the next listing re-read just that playlist.
 */
export async function unprocessedWeeklyPlaylists(
  deps: UnprocessedWeeklyPlaylistsDeps,
  allWeeklyId: string,
  log: (message: string, level?: 'info' | 'debug') => void = () => {},
): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }> {
  const { store, data, userId } = deps;

  const awTrackIds = new Set(await store.trackIds(allWeeklyId));
  log(`Loaded ${awTrackIds.size} tracks from All Weekly`);

  const weeklies = (await store.list(userId))
    .filter((pl) => pl.trackCount > 0 && isWeeklyPlaylistName(pl.name))
    .sort((a, b) => parseDate(b.name).getTime() - parseDate(a.name).getTime());
  log(`Found ${weeklies.length} weekly playlists, scanning from newest...`);

  const cached = (await data.load(WEEKLY_PLAYLIST_TRACKS)) ?? {};
  // Only the playlists this walk visits are kept; the rest drop out.
  const walked: Record<string, WeeklyPlaylistTrackIds> = {};
  const unprocessed: SimplePlaylist[] = [];
  let read = 0;
  let reused = 0;

  for (const pl of weeklies) {
    const hit = cached[pl.id];
    let trackIds: string[];
    if (pl.snapshotId && hit?.snapshotId === pl.snapshotId) {
      trackIds = hit.trackIds;
      reused++;
    } else {
      trackIds = await store.trackIds(pl.id);
      read++;
    }
    if (pl.snapshotId) walked[pl.id] = { snapshotId: pl.snapshotId, trackIds };

    if (trackIds.some((id) => awTrackIds.has(id))) {
      log(`  ${pl.name} — AW overlap found, cutoff reached`, 'debug');
      break;
    }
    log(`  ${pl.name} — unprocessed (${unprocessed.length + 1})`, 'debug');
    unprocessed.push(pl);
  }

  await data.save(WEEKLY_PLAYLIST_TRACKS, walked);
  log(
    `Result: ${unprocessed.length} unprocessed weekly playlists (${read} read, ${reused} unchanged)`,
  );

  return { playlists: unprocessed.reverse(), awTrackIds };
}
