import { formatHm } from '../../domain/tracks.js';
import {
  type ListeningTime,
  unprocessedReports,
} from '../../services/unprocessed-reports/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface ListeningTimeEvents extends BaseEvents {
  'listeningTime:complete': ListeningTime;
}

export const listeningTimeTask: TaskDefinition<ListeningTimeEvents> = {
  name: 'listening-time',
  path: '/listening-time',
  startMessage: 'Listening time calculation started',

  async run(tc: TaskContext<ListeningTimeEvents>) {
    let runningMs = 0;
    const result = await unprocessedReports(tc.session, {
      log: (msg, level) => tc.log(level ?? 'info', msg),
    }).listeningTime({
      onPlaylist: (done, total, pl, measured) => {
        runningMs += measured.durationMs;
        tc.progress.bar(
          'lt',
          done,
          total,
          `${done}/${total} — ${pl.name} (${formatHm(runningMs)})`,
        );
      },
    });

    tc.emit('listeningTime:complete', result);
    tc.log(
      'success',
      `Listening time: ${formatHm(result.totalMs)} across ${result.playlistCount} unprocessed weekly playlists (${result.totalTracks} tracks) · avg ${formatHm(result.averageMs)}/playlist${result.cachedReads ? ` — ${result.cachedReads} cached` : ''}`,
    );
  },
};
