import { generateFridayDates, parseDate } from '../../domain/tracks.js';
import type { SimplePlaylist } from '../../lib/types.js';

/**
 * Weekly playlists — the date-named (`DD.MM.YY`) playlists holding one
 * Friday's week collection each. This module owns what makes a playlist a
 * weekly playlist, when a Friday counts as unfilled, and the write itself:
 * reuse the date's empty playlist or create it, add the tracks, and drop the
 * unprocessed-playlists listing the write just staled.
 */

// ── Ports (the seam) ─────────────────────────────────────────────────────────

/**
 * The playlist reads and writes a weekly playlist needs. Prod adapter wraps
 * SpotifyContext + pagination; test adapter is an in-memory listing.
 *
 * Error contract: `create` and `addTracks` throw on any failure, auth
 * failures included (the fill re-auths and retries the date). A throw from
 * `addTracks` means the write must not be treated as done.
 */
export interface WeeklyPlaylistStore {
  /** Every playlist the user owns, all pages. */
  list(userId: string): Promise<SimplePlaylist[]>;
  create(userId: string, name: string): Promise<{ id: string; url: string }>;
  addTracks(playlistId: string, trackIds: string[]): Promise<void>;
}

// ── Naming ───────────────────────────────────────────────────────────────────

const WEEKLY_NAME = /^\d{2}\.\d{2}\.\d{2}$/;

/** Whether a playlist name is a weekly playlist's `DD.MM.YY` date. */
export function isWeeklyPlaylistName(name: string): boolean {
  return WEEKLY_NAME.test(name);
}

/** The first Friday a fill covers for a user with no weekly playlists yet. */
const DEFAULT_START = new Date(2025, 4, 23);

const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;

// ── Interface ────────────────────────────────────────────────────────────────

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
   * then add the tracks. The unprocessed listing is invalidated before the
   * first add, so a partial write still leaves it dropped. A filled playlist
   * is left alone.
   */
  write(date: string, trackIds: string[]): Promise<WeeklyWrite>;
}

export interface WeeklyPlaylistsDeps {
  store: WeeklyPlaylistStore;
  userId: string;
  /** Drops the cached unprocessed-playlists listing. */
  invalidateUnprocessed(): Promise<void>;
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
      weeklies = (await store.list(userId)).filter((p) =>
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
      const existing = all.find((p) => p.name === date);
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
        await deps.invalidateUnprocessed();
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
