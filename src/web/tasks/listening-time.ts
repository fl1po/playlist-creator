import fs from 'node:fs';
import path from 'node:path';
import { formatHm } from '../../domain/tracks.js';
import {
  DURATION_SNAPSHOT_CACHE,
  type DurationSnapshots,
  LISTENING_TIME_CACHE,
} from '../../lib/cache-files.js';
import { getPlaylistTotalDuration } from '../../lib/pagination.js';
import { getNonListenedPlaylists } from '../../services/non-listened-playlists.js';
import { broadcastApiCallbacks } from '../../services/playlist-filler/subscribers.js';
import { redisLoadCache, redisSaveCache } from '../redis-config-store.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface ListeningTimeResult {
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
  'listeningTime:progress': {
    current: number;
    total: number;
    playlistName: string;
    totalMs: number;
  };
  'listeningTime:complete': ListeningTimeResult;
}

type ListeningTimeCacheKey = 'durationSnapshots';

export const listeningTimeTask: TaskDefinition<
  ListeningTimeEvents,
  ListeningTimeCacheKey
> = {
  name: 'listening-time',
  path: '/listening-time',
  startMessage: 'Listening time calculation started',
  apiCallbacks: (b) => broadcastApiCallbacks(b),
  caches: [{ key: 'durationSnapshots', file: DURATION_SNAPSHOT_CACHE }],

  async run(tc: TaskContext<ListeningTimeEvents, ListeningTimeCacheKey>) {
    const userConfig = await tc.userConfig();
    const me = await tc.me();

    const { playlists: candidates } = await getNonListenedPlaylists(
      tc.ctx,
      me.id,
      userConfig.sourcePlaylists.allWeeklyId,
      tc.dataDir,
      (msg, level) => tc.log(level ?? 'info', msg),
    );

    const force = !!tc.body.force;

    const snapshotPath = path.join(tc.dataDir, DURATION_SNAPSHOT_CACHE);
    let snapshots: DurationSnapshots = {};
    if (!force) {
      try {
        snapshots = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      } catch {
        // No local file — fall back to the durable Redis copy so a fresh
        // container reuses snapshots instead of repaginating every playlist.
        try {
          snapshots =
            (await redisLoadCache<DurationSnapshots>(
              tc.userId,
              'durationSnapshots',
            )) ?? {};
        } catch {
          /* redis optional */
        }
      }
    }

    let totalMs = 0;
    let totalTracks = 0;
    let cached = 0;
    const perPlaylist: ListeningTimeResult['perPlaylist'] = [];

    await tc.iter(candidates, async (pl, i) => {
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

      tc.emit('listeningTime:progress', {
        current: i + 1,
        total: candidates.length,
        playlistName: pl.name,
        totalMs,
      });
    });

    // Prune stale entries and persist
    const candidateIds = new Set(candidates.map((c) => c.id));
    for (const id of Object.keys(snapshots)) {
      if (!candidateIds.has(id)) delete snapshots[id];
    }
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshots, null, 2));

    const result: ListeningTimeResult = {
      totalMs,
      totalTracks,
      playlistCount: candidates.length,
      perPlaylist,
    };

    fs.writeFileSync(
      path.join(tc.dataDir, LISTENING_TIME_CACHE),
      JSON.stringify(result, null, 2),
    );

    tc.emit('listeningTime:complete', result);

    tc.emitData('durationSnapshots', snapshots);
    tc.emitData('listeningTime', result);
    try {
      await redisSaveCache(tc.userId, 'durationSnapshots', snapshots);
      await redisSaveCache(tc.userId, 'listeningTime', result);
    } catch {
      /* redis optional */
    }

    const avg = candidates.length > 0 ? totalMs / candidates.length : 0;
    tc.log(
      'success',
      `Listening time: ${formatHm(totalMs)} across ${candidates.length} non-listened playlists (${totalTracks} tracks) · avg ${formatHm(avg)}/playlist${cached ? ` — ${cached} cached` : ''}`,
    );
  },
};
