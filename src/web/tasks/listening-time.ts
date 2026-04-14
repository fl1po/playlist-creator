import fs from 'node:fs';
import path from 'node:path';
import {
  getNonListenedPlaylists,
  getPlaylistTotalDuration,
  LISTENING_TIME_CACHE,
} from '../../lib/pagination.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

export const listeningTimeTask: TaskDefinition = {
  name: 'listening-time',
  path: '/listening-time',
  startMessage: 'Listening time calculation started',

  async run(tc: TaskContext) {
    const userConfig = tc.userConfigStore.load();
    const me = await tc.client.api.currentUser.profile();

    const { playlists: candidates } = await getNonListenedPlaylists(
      tc.ctx,
      me.id,
      userConfig.sourcePlaylists.allWeeklyId,
      tc.dataDir,
      (msg) => tc.broadcast('log', { level: 'info', message: msg }),
    );

    let totalMs = 0;
    let totalTracks = 0;
    const perPlaylist: Array<{
      name: string;
      durationMs: number;
      trackCount: number;
    }> = [];

    for (let i = 0; i < candidates.length; i++) {
      tc.checkAbort();
      const pl = candidates[i];

      const { totalMs: plMs, trackCount: plTracks } =
        await getPlaylistTotalDuration(tc.ctx, pl.id);
      totalMs += plMs;
      totalTracks += plTracks;
      perPlaylist.push({
        name: pl.name,
        durationMs: plMs,
        trackCount: plTracks,
      });

      tc.broadcast('listeningTime:progress', {
        current: i + 1,
        total: candidates.length,
        playlistName: pl.name,
        totalMs,
      });
    }

    const result = {
      totalMs,
      totalTracks,
      playlistCount: candidates.length,
      perPlaylist,
    };

    fs.writeFileSync(
      path.join(tc.dataDir, LISTENING_TIME_CACHE),
      JSON.stringify(result, null, 2),
    );

    tc.broadcast('listeningTime:complete', result);

    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.round((totalMs % 3600000) / 60000);
    tc.broadcast('log', {
      level: 'success',
      message: `Listening time: ${hours}h ${minutes}m across ${candidates.length} non-listened playlists (${totalTracks} tracks)`,
    });
  },
};
