import fs from 'node:fs';
import path from 'node:path';
import {
  getPlaylistTracksGroupedByWeek,
  type WeekBreakdownEntry,
} from '../../domain/aw-breakdown.js';
import { formatHm } from '../../domain/tracks.js';
import { AW_BREAKDOWN_CACHE } from '../../lib/cache-files.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface AwBreakdownCache {
  snapshotId: string;
  totalTracks: number;
  totalDurationMs: number;
  weekCount: number;
  weeks: WeekBreakdownEntry[];
}

interface AwBreakdownEvents extends BaseEvents {
  'awBreakdown:complete': AwBreakdownCache;
  'awBreakdown:progress': { fetched: number; total: number };
}

type AwBreakdownCacheKey = 'awBreakdown';

export const awBreakdownTask: TaskDefinition<
  AwBreakdownEvents,
  AwBreakdownCacheKey
> = {
  name: 'aw-breakdown',
  path: '/aw-breakdown',
  startMessage: 'AW breakdown calculation started',
  caches: [{ key: 'awBreakdown', file: AW_BREAKDOWN_CACHE }],

  async run(tc: TaskContext<AwBreakdownEvents, AwBreakdownCacheKey>) {
    const userConfig = await tc.userConfig();
    const awId = userConfig.sourcePlaylists.allWeeklyId;

    const cachePath = path.join(tc.dataDir, AW_BREAKDOWN_CACHE);
    let cached: AwBreakdownCache | null = null;
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch {
      /* no cache yet */
    }

    const awInfo = await tc.ctx.call(
      () => tc.ctx.api.playlists.getPlaylist(awId, undefined, 'snapshot_id'),
      'AW playlist info',
    );
    const liveSnapshot = awInfo.success ? awInfo.data.snapshot_id : undefined;

    const force = !!tc.body.force;

    if (
      !force &&
      cached &&
      liveSnapshot &&
      cached.snapshotId === liveSnapshot
    ) {
      tc.emit('awBreakdown:complete', cached);
      tc.log(
        'success',
        `AW breakdown: ${cached.weekCount} weeks, ${cached.totalTracks} tracks (cached)`,
      );
      return;
    }

    tc.log('info', 'Fetching AW tracks...');

    const weeks = await getPlaylistTracksGroupedByWeek(tc.ctx, awId, {
      onProgress: (fetched, total) => {
        tc.checkAbort();
        tc.emit('awBreakdown:progress', { fetched, total });
      },
    });

    const totalTracks = weeks.reduce((s, w) => s + w.trackCount, 0);
    const totalDurationMs = weeks.reduce((s, w) => s + w.durationMs, 0);

    const result: AwBreakdownCache = {
      snapshotId: liveSnapshot ?? '',
      totalTracks,
      totalDurationMs,
      weekCount: weeks.length,
      weeks,
    };

    fs.mkdirSync(tc.dataDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
    tc.emitData('awBreakdown', result);
    tc.emit('awBreakdown:complete', result);

    const avgTracks =
      weeks.length > 0 ? Math.round(totalTracks / weeks.length) : 0;
    const avgDuration =
      weeks.length > 0 ? formatHm(totalDurationMs / weeks.length) : '0m';
    tc.log(
      'success',
      `AW breakdown: ${weeks.length} weeks, ${totalTracks} tracks, ${formatHm(totalDurationMs)} · avg ${avgTracks} tracks/${avgDuration} per week`,
    );
  },
};
