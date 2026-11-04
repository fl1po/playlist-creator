import { formatHm } from '../../domain/tracks.js';
import { itemsOf, playlistReads } from '../../lib/playlist-reads/index.js';
import { LISTENING_TIME } from '../../lib/user-data/index.js';
import { spotifyWeeklyPlaylistStore } from '../../services/weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../../services/weekly-playlists/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

/** The last calculation, kept until the next; the page shows its age. */
interface ListeningTimeResult {
  /** When it was calculated (ISO); later fills and listens aren't in it. */
  computedAt: string;
  totalMs: number;
  totalTracks: number;
  playlistCount: number;
  perPlaylist: Array<{
    name: string;
    durationMs: number;
    trackCount: number;
    ready: boolean;
  }>;
}

interface ListeningTimeEvents extends BaseEvents {
  'listeningTime:complete': ListeningTimeResult;
}

export const listeningTimeTask: TaskDefinition<ListeningTimeEvents> = {
  name: 'listening-time',
  path: '/listening-time',
  startMessage: 'Listening time calculation started',

  async run(tc: TaskContext<ListeningTimeEvents>) {
    const userConfig = await tc.userConfig();
    const me = await tc.me();

    const { playlists: candidates } = await unprocessedWeeklyPlaylists(
      {
        store: spotifyWeeklyPlaylistStore(tc.session),
        userId: me.id,
      },
      userConfig.sourcePlaylists.allWeeklyId,
      (msg, level) => tc.log(level ?? 'info', msg),
    );

    // Each playlist's tracks come from playlist reads with the listing's
    // snapshot, so an unchanged one costs no call at all.
    const playlists = playlistReads(tc.session);
    let totalMs = 0;
    let totalTracks = 0;
    let cached = 0;
    const perPlaylist: ListeningTimeResult['perPlaylist'] = [];

    await tc.iter(candidates, async (pl, i) => {
      const read = await playlists.tracks(pl.id, { snapshot: pl.snapshotId });
      const tracks = itemsOf(read).flatMap((item) =>
        item.track ? [item.track] : [],
      );
      if (read.success && read.cached) cached++;
      const plMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);

      totalMs += plMs;
      totalTracks += tracks.length;
      perPlaylist.push({
        name: pl.name,
        durationMs: plMs,
        trackCount: tracks.length,
        // A weekly playlist is ready once its description is cleared.
        ready: !pl.description,
      });

      tc.progress.bar(
        'lt',
        i + 1,
        candidates.length,
        `${i + 1}/${candidates.length} — ${pl.name} (${formatHm(totalMs)})`,
      );
    });

    const result: ListeningTimeResult = {
      computedAt: new Date().toISOString(),
      totalMs,
      totalTracks,
      playlistCount: candidates.length,
      perPlaylist,
    };

    await tc.session.data.save(LISTENING_TIME, result);

    tc.emit('listeningTime:complete', result);

    const avg = candidates.length > 0 ? totalMs / candidates.length : 0;
    tc.log(
      'success',
      `Listening time: ${formatHm(totalMs)} across ${candidates.length} unprocessed weekly playlists (${totalTracks} tracks) · avg ${formatHm(avg)}/playlist${cached ? ` — ${cached} cached` : ''}`,
    );
  },
};
