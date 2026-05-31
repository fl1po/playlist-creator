import fs from 'node:fs';
import path from 'node:path';
import { type BatchCache, toCachedScanResult } from '../../lib/types.js';
import type { PriorityCalculatorEventMap } from '../../services/priority-calculator.js';
import {
  diffSnapshots,
  fetchSourceSnapshots,
  pickReusableScans,
  recalculate,
  snapshotPriorities,
} from '../../services/recalculate.js';
import { broadcastEvents } from '../broadcast.js';
import { syncIfNeeded } from '../priority-diff.js';
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
    const cache = (tc.caches.batchCache ??
      (await redisLoadBatchCache(tc.userId)) ??
      {}) as BatchCache;

    const live = await fetchSourceSnapshots(tc.ctx, userConfig.sourcePlaylists);
    const delta = diffSnapshots(cache, live);

    if (
      !force &&
      cache.allWeeklySnapshot &&
      cache.bestOfAllWeeklySnapshot &&
      !delta.anyChanged
    ) {
      tc.broadcast('log', {
        level: 'info',
        message: 'Snapshots unchanged — skipping recalculation',
      });
      return;
    }

    const trustedPath = path.join(tc.dataDir, 'trusted-artists.json');
    const prior = snapshotPriorities(trustedPath);

    const result = await recalculate({
      ctx: tc.ctx,
      sources: userConfig.sourcePlaylists,
      scoring: {
        weights: userConfig.scoring,
        thresholds: userConfig.scoring.priorityThresholds,
      },
      preloaded: pickReusableScans(cache, delta),
      prior,
      events: broadcastEvents<PriorityCalculatorEventMap>(tc.broadcast, {
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
    });

    const changes = result.tierChanges ?? [];
    changes.sort(
      (a, b) => (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
    );
    tc.broadcast('recalc:changes', { changes });

    // Sync unprocessed playlists if P1/P2 boundary crossings occurred.
    // Must complete before persisting, so a failure allows re-running from scratch.
    await syncIfNeeded(
      changes,
      tc.rawClient,
      tc.dataDir,
      userConfig.sourcePlaylists.allWeeklyId,
      tc.pacer,
      tc.broadcast,
    );

    // Persist only after the entire process (including sync) succeeds
    fs.writeFileSync(
      trustedPath,
      JSON.stringify(result.trustedArtists, null, 2),
    );
    tc.emitData('trustedArtists', result.trustedArtists);
    const updatedCache: BatchCache = {
      ...cache,
      ...(live.aw && { allWeeklySnapshot: live.aw }),
      ...(live.boaw && { bestOfAllWeeklySnapshot: live.boaw }),
      awScanCache: toCachedScanResult(result.scanResults.aw),
      boawScanCache: toCachedScanResult(result.scanResults.boaw),
    };
    tc.emitData('batchCache', updatedCache);
    await redisSaveBatchCache(tc.userId, updatedCache);
    await redisSaveTrustedArtists(tc.userId, result.trustedArtists);

    tc.broadcast('log', {
      level: 'success',
      message: 'Priorities recalculated and saved',
    });
  },
};
