import {
  itemsOf,
  type PlaylistItem,
  playlistReads,
} from '../../lib/playlist-reads/index.js';
import type { SimplePlaylist } from '../../lib/types.js';
import { LISTENING_TIME } from '../../lib/user-data/index.js';
import type { UserSession } from '../../lib/user-session.js';
import { type DuplicateGroup, findDuplicates } from '../dedup.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../weekly-playlists/index.js';

/*
 * Unprocessed reports (CONTEXT.md): measurements over the unprocessed weekly
 * playlists, recomputed in memory from playlist reads on every run. Each run
 * lists the unprocessed weekly playlists afresh (ADR-0009) and reads each one
 * with the listing's snapshot, so an unchanged playlist costs no call
 * (ADR-0011).
 */

export interface PlaylistListeningTime {
  name: string;
  durationMs: number;
  trackCount: number;
  /** A weekly playlist is ready once its description is cleared. */
  ready: boolean;
}

/** The last listening time, kept for the page to show with its age. */
export interface ListeningTime {
  /** When it was measured (ISO); later fills and listens aren't in it. */
  computedAt: string;
  totalMs: number;
  totalTracks: number;
  playlistCount: number;
  /** Per unprocessed weekly playlist. */
  averageMs: number;
  /** How many playlists were read with no item fetched. */
  cachedReads: number;
  perPlaylist: PlaylistListeningTime[];
}

export interface PlaylistDuplicates {
  id: string;
  name: string;
  /** How many tracks would leave the playlist: every later copy. */
  duplicateCount: number;
  groups: DuplicateGroup[];
}

export interface Duplicates {
  /** How many unprocessed weekly playlists were scanned. */
  scanned: number;
  totalDuplicates: number;
  /** Only the playlists that have duplicates, oldest first. */
  playlists: PlaylistDuplicates[];
}

/**
 * Called after each playlist is measured: how many are done of how many, the
 * playlist, and that playlist's own measurement.
 */
export type OnPlaylist<M> = (
  done: number,
  total: number,
  playlist: SimplePlaylist,
  measured: M,
) => void;

export interface UnprocessedReports {
  /** Listening time across the unprocessed weekly playlists; kept as the last one. */
  listeningTime(opts?: {
    onPlaylist?: OnPlaylist<PlaylistListeningTime>;
  }): Promise<ListeningTime>;
  /** Duplicates in each unprocessed weekly playlist, by the rule removal uses. */
  duplicates(opts?: {
    onPlaylist?: OnPlaylist<PlaylistDuplicates>;
  }): Promise<Duplicates>;
}

export interface UnprocessedReportsOpts {
  /** The listing's own lines (All Weekly loaded, cutoff reached, …). */
  log?: (message: string, level?: 'info' | 'debug') => void;
  now?: () => Date;
}

/**
 * The unprocessed reports of the session's user. A stop of the session's
 * gateway ends a report before its next playlist, even one served from cache.
 * A playlist that can't be read fails the report.
 */
export function unprocessedReports(
  session: UserSession,
  opts: UnprocessedReportsOpts = {},
): UnprocessedReports {
  const { log, now = () => new Date() } = opts;
  const reads = playlistReads(session);

  /** Each unprocessed weekly playlist's read, measured in turn. */
  async function measureEach<M>(
    measure: (pl: SimplePlaylist, items: PlaylistItem[], cached: boolean) => M,
    onPlaylist?: OnPlaylist<M>,
  ): Promise<{ playlists: SimplePlaylist[]; measured: M[] }> {
    const config = await session.data.config.load();
    const { playlists } = await unprocessedWeeklyPlaylists(
      { store: spotifyWeeklyPlaylistStore(session), userId: session.userId },
      config.sourcePlaylists.allWeeklyId,
      log,
    );
    const measured: M[] = [];
    for (const pl of playlists) {
      session.gateway.signal?.throwIfAborted();
      const read = await reads.tracks(pl.id, { snapshot: pl.snapshotId });
      const m = measure(pl, itemsOf(read), read.success && read.cached);
      measured.push(m);
      onPlaylist?.(measured.length, playlists.length, pl, m);
    }
    return { playlists, measured };
  }

  return {
    async listeningTime({ onPlaylist } = {}) {
      let cachedReads = 0;
      const { playlists, measured } = await measureEach(
        (pl, items, cached): PlaylistListeningTime => {
          if (cached) cachedReads++;
          const tracks = items.flatMap((i) => (i.track ? [i.track] : []));
          return {
            name: pl.name,
            durationMs: tracks.reduce((s, t) => s + t.durationMs, 0),
            trackCount: tracks.length,
            ready: !pl.description,
          };
        },
        onPlaylist,
      );
      const totalMs = measured.reduce((s, p) => s + p.durationMs, 0);
      const result: ListeningTime = {
        computedAt: now().toISOString(),
        totalMs,
        totalTracks: measured.reduce((s, p) => s + p.trackCount, 0),
        playlistCount: playlists.length,
        averageMs: playlists.length > 0 ? totalMs / playlists.length : 0,
        cachedReads,
        perPlaylist: measured,
      };
      await session.data.save(LISTENING_TIME, result);
      return result;
    },

    async duplicates({ onPlaylist } = {}) {
      const { playlists, measured } = await measureEach(
        (pl, items): PlaylistDuplicates => {
          const groups = findDuplicates(items);
          return {
            id: pl.id,
            name: pl.name,
            duplicateCount: groups.reduce((s, g) => s + g.extra.length, 0),
            groups,
          };
        },
        onPlaylist,
      );
      const withDuplicates = measured.filter((p) => p.duplicateCount > 0);
      return {
        scanned: playlists.length,
        totalDuplicates: withDuplicates.reduce(
          (s, p) => s + p.duplicateCount,
          0,
        ),
        playlists: withDuplicates,
      };
    },
  };
}
