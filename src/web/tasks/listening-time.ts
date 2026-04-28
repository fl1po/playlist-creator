import fs from 'node:fs';
import path from 'node:path';
import { formatHm } from '../../domain/tracks.js';
import {
  DURATION_SNAPSHOT_CACHE,
  getNonListenedPlaylists,
  getPlaylistTotalDuration,
  LISTENING_TIME_CACHE,
} from '../../lib/pagination.js';
import type { DurationSnapshots } from '../../lib/pagination.js';
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

    const snapshotPath = path.join(tc.dataDir, DURATION_SNAPSHOT_CACHE);
    let snapshots: DurationSnapshots = {};
    try {
      snapshots = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    } catch {
      /* no cache yet */
    }

    let totalMs = 0;
    let totalTracks = 0;
    let cached = 0;
    const perPlaylist: Array<{
      name: string;
      durationMs: number;
      trackCount: number;
      ready: boolean;
    }> = [];

    for (let i = 0; i < candidates.length; i++) {
      tc.checkAbort();
      const pl = candidates[i];

      let plMs: number;
      let plTracks: number;

      const plInfo = await tc.ctx.call(
        () =>
          tc.ctx.api.playlists.getPlaylist(
            pl.id,
            undefined,
            'snapshot_id,description',
          ),
        `playlist info ${pl.id}`,
      );
      const liveSnapshotId = plInfo.success
        ? plInfo.data.snapshot_id
        : undefined;
      const ready = plInfo.success ? !plInfo.data.description : false;

      const snap = snapshots[pl.id];
      if (snap && liveSnapshotId && snap.snapshotId === liveSnapshotId) {
        plMs = snap.totalMs;
        plTracks = snap.trackCount;
        cached++;
      } else {
        const dur = await getPlaylistTotalDuration(tc.ctx, pl.id);
        plMs = dur.totalMs;
        plTracks = dur.trackCount;
        if (liveSnapshotId) {
          snapshots[pl.id] = {
            snapshotId: liveSnapshotId,
            totalMs: plMs,
            trackCount: plTracks,
          };
        }
      }

      totalMs += plMs;
      totalTracks += plTracks;
      perPlaylist.push({
        name: pl.name,
        durationMs: plMs,
        trackCount: plTracks,
        ready,
      });

      tc.broadcast('listeningTime:progress', {
        current: i + 1,
        total: candidates.length,
        playlistName: pl.name,
        totalMs,
      });
    }

    // Prune stale entries and persist
    const candidateIds = new Set(candidates.map((c) => c.id));
    for (const id of Object.keys(snapshots)) {
      if (!candidateIds.has(id)) delete snapshots[id];
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshots, null, 2));

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

    const avg = candidates.length > 0 ? totalMs / candidates.length : 0;
    tc.broadcast('log', {
      level: 'success',
      message: `Listening time: ${formatHm(totalMs)} across ${candidates.length} non-listened playlists (${totalTracks} tracks) · avg ${formatHm(avg)}/playlist${cached ? ` — ${cached} cached` : ''}`,
    });
  },
};
