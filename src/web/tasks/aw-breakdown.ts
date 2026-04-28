import fs from 'node:fs';
import path from 'node:path';
import { formatHm } from '../../domain/tracks.js';
import {
  AW_BREAKDOWN_CACHE,
  getPlaylistTracksGroupedByWeek,
} from '../../lib/pagination.js';
import type { WeekBreakdownEntry } from '../../lib/pagination.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

interface AwBreakdownCache {
  snapshotId: string;
  totalTracks: number;
  totalDurationMs: number;
  weekCount: number;
  weeks: WeekBreakdownEntry[];
}

export const awBreakdownTask: TaskDefinition = {
  name: 'aw-breakdown',
  path: '/aw-breakdown',
  startMessage: 'AW breakdown calculation started',

  async run(tc: TaskContext) {
    const userConfig = tc.userConfigStore.load();
    const awId = userConfig.sourcePlaylists.allWeeklyId;

    // Check if AW snapshot changed
    const cachePath = path.join(tc.dataDir, AW_BREAKDOWN_CACHE);
    let cached: AwBreakdownCache | null = null;
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch {
      /* no cache yet */
    }

    const awInfo = await tc.ctx.call(
      () =>
        tc.ctx.api.playlists.getPlaylist(awId, undefined, 'snapshot_id'),
      'AW playlist info',
    );
    const liveSnapshot = awInfo.success ? awInfo.data.snapshot_id : undefined;

    const force = !!tc.body.force;

    if (!force && cached && liveSnapshot && cached.snapshotId === liveSnapshot) {
      tc.broadcast('awBreakdown:complete', cached);
      tc.broadcast('log', {
        level: 'success',
        message: `AW breakdown: ${cached.weekCount} weeks, ${cached.totalTracks} tracks (cached)`,
      });
      return;
    }

    // Compute fresh breakdown
    tc.broadcast('log', {
      level: 'info',
      message: 'Fetching AW tracks...',
    });

    const weeks = await getPlaylistTracksGroupedByWeek(
      tc.ctx,
      awId,
      (fetched, total) => {
        tc.checkAbort();
        tc.broadcast('awBreakdown:progress', { fetched, total });
      },
    );

    const totalTracks = weeks.reduce((s, w) => s + w.trackCount, 0);
    const totalDurationMs = weeks.reduce((s, w) => s + w.durationMs, 0);

    const result: AwBreakdownCache = {
      snapshotId: liveSnapshot ?? '',
      totalTracks,
      totalDurationMs,
      weekCount: weeks.length,
      weeks,
    };

    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
    tc.broadcast('awBreakdown:complete', result);

    const avgTracks =
      weeks.length > 0 ? Math.round(totalTracks / weeks.length) : 0;
    const avgDuration =
      weeks.length > 0 ? formatHm(totalDurationMs / weeks.length) : '0m';
    tc.broadcast('log', {
      level: 'success',
      message: `AW breakdown: ${weeks.length} weeks, ${totalTracks} tracks, ${formatHm(totalDurationMs)} · avg ${avgTracks} tracks/${avgDuration} per week`,
    });
  },
};
