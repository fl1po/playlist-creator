import fs from 'node:fs';
import path from 'node:path';
import { type BatchCache, type PlaylistScanResult, toCachedScanResult, toScanResult } from '../../lib/types.js';
import {
  type PriorityCalculatorEventMap,
  PriorityCalculatorService,
} from '../../services/priority-calculator.js';
import { broadcastEvents } from '../broadcast.js';
import {
  diffPriorities,
  snapshotPriorities,
  syncIfNeeded,
} from '../priority-diff.js';
import {
  redisLoadBatchCache,
  redisSaveBatchCache,
  redisSaveTrustedArtists,
} from '../redis-config-store.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

export const recalculateTask: TaskDefinition = {
  name: 'recalculate',
  path: '/recalculate',
  startMessage: 'Recalculation started',

  async run(tc: TaskContext) {
    tc.broadcast('log', {
      level: 'info',
      message: 'Starting priority recalculation...',
    });

    // Hydrate data dir from client caches
    if (tc.caches.trustedArtists) {
      fs.mkdirSync(tc.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(tc.dataDir, 'trusted-artists.json'),
        JSON.stringify(tc.caches.trustedArtists, null, 2),
      );
    }

    const userConfig = await tc.userConfigStore.load();
    const force = !!tc.body.force;
    const cache = (tc.caches.batchCache ?? await redisLoadBatchCache(tc.userId) ?? {}) as BatchCache;

    // Fetch live snapshots (2 cheap API calls)
    const awResult = await tc.ctx.call(
      () => tc.ctx.api.playlists.getPlaylist(userConfig.sourcePlaylists.allWeeklyId, undefined, 'snapshot_id'),
      'All Weekly snapshot',
    );
    const awSnapshot = awResult.success ? awResult.data.snapshot_id : undefined;

    let boawSnapshot: string | undefined;
    if (userConfig.sourcePlaylists.useLikedSongs) {
      const likedResult = await tc.ctx.call(
        () => tc.ctx.api.currentUser.tracks.savedTracks(1, 0),
        'Liked Songs snapshot',
      );
      if (likedResult.success) {
        const data = likedResult.data as any;
        boawSnapshot = `${data.total ?? 0}:${data.items?.[0]?.added_at ?? ''}`;
      }
    } else {
      const boawResult = await tc.ctx.call(
        () => tc.ctx.api.playlists.getPlaylist(userConfig.sourcePlaylists.bestOfAllWeeklyId, undefined, 'snapshot_id'),
        'BoAW snapshot',
      );
      boawSnapshot = boawResult.success ? boawResult.data.snapshot_id : undefined;
    }

    // Skip if snapshots unchanged
    if (!force && cache.allWeeklySnapshot && cache.bestOfAllWeeklySnapshot) {
      const awUnchanged = awSnapshot && cache.allWeeklySnapshot === awSnapshot;
      const boawUnchanged = boawSnapshot && cache.bestOfAllWeeklySnapshot === boawSnapshot;
      if (awUnchanged && boawUnchanged) {
        tc.broadcast('log', { level: 'info', message: 'Snapshots unchanged — skipping recalculation' });
        return;
      }
    }

    // Reuse cached scan data for unchanged sources
    const awUnchanged = awSnapshot && cache.allWeeklySnapshot === awSnapshot;
    const boawUnchanged = boawSnapshot && cache.bestOfAllWeeklySnapshot === boawSnapshot;
    const preloaded: { aw?: PlaylistScanResult; boaw?: PlaylistScanResult } = {};
    if (awUnchanged && cache.awScanCache) {
      preloaded.aw = toScanResult(cache.awScanCache);
    }
    if (boawUnchanged && cache.boawScanCache) {
      preloaded.boaw = toScanResult(cache.boawScanCache);
    }

    const service = new PriorityCalculatorService(
      tc.ctx,
      {
        allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
        bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
        useLikedSongs: userConfig.sourcePlaylists.useLikedSongs,
        scoringWeights: userConfig.scoring,
        priorityThresholds: userConfig.scoring.priorityThresholds,
        preloaded,
      },
      broadcastEvents<PriorityCalculatorEventMap>(tc.broadcast, {
        scanStart: {
          type: 'recalc:scanStart',
          pack: (name) => {
            tc.checkAbort();
            return { playlist: name };
          },
        },
        scanProgress: {
          type: 'recalc:scanProgress',
          pack: (name, offset, total) => {
            tc.checkAbort();
            return { playlist: name, offset, total };
          },
        },
        scanComplete: {
          type: 'recalc:scanProgress',
          pack: (name, artistCount, trackCount) => ({
            playlist: name,
            artists: artistCount,
            tracks: trackCount,
          }),
        },
        calculationComplete: {
          type: 'recalc:complete',
          pack: (stats) => stats,
        },
        topArtists: {
          type: 'recalc:topArtists',
          pack: (artists) => ({
            artists: artists.map(([name, data]) => ({ name, ...data })),
          }),
        },
        saved: { log: (p) => `Saved to ${p}`, level: 'success' },
      }),
    );

    const trustedPath = path.join(tc.dataDir, 'trusted-artists.json');
    const oldPriorities = snapshotPriorities(trustedPath);

    const { scanResults, ...output } = await service.run();
    fs.writeFileSync(trustedPath, JSON.stringify(output, null, 2));

    const changes = diffPriorities(oldPriorities, output);
    changes.sort(
      (a, b) => (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
    );
    tc.broadcast('recalc:changes', { changes });

    // Emit updated trusted artists and snapshots to client + persist to Redis
    tc.emitData('trustedArtists', output);
    const updatedCache: BatchCache = {
      ...cache,
      ...(awSnapshot && { allWeeklySnapshot: awSnapshot }),
      ...(boawSnapshot && { bestOfAllWeeklySnapshot: boawSnapshot }),
      awScanCache: toCachedScanResult(scanResults.aw),
      boawScanCache: toCachedScanResult(scanResults.boaw),
    };
    tc.emitData('batchCache', updatedCache);
    await redisSaveBatchCache(tc.userId, updatedCache);
    await redisSaveTrustedArtists(tc.userId, output);

    tc.broadcast('log', {
      level: 'success',
      message: 'Priorities recalculated and saved',
    });

    // Sync unprocessed playlists if P1/P2 boundary crossings occurred
    try {
      await syncIfNeeded(
        changes,
        tc.rawClient,
        tc.dataDir,
        userConfig.sourcePlaylists.allWeeklyId,
        tc.pacer,
        tc.broadcast,
      );
    } catch (syncErr) {
      tc.broadcast('log', {
        level: 'warn',
        message: `Post-recalc sync failed: ${syncErr}`,
      });
    }
  },
};
