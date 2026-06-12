import fs from 'node:fs';
import path from 'node:path';
import { broadcastEvents } from '../../lib/service-events.js';
import { type BatchCache, toCachedScanResult } from '../../lib/types.js';
import type { PriorityCalculatorEventMap } from '../../services/priority-calculator.js';
import {
  type PriorityChange,
  diffSnapshots,
  fetchSourceSnapshots,
  pickReusableScans,
  recalculate,
  snapshotPriorities,
} from '../../services/recalculate.js';
import { syncIfNeeded } from '../priority-diff.js';
import {
  redisLoadBatchCache,
  redisSaveBatchCache,
  redisSaveTrustedArtists,
} from '../redis-config-store.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface RecalculateEvents extends BaseEvents {
  'recalc:changes': { changes: PriorityChange[] };
  // Scan events (recalc:scanStart / scanProgress / complete / topArtists) are
  // emitted via `broadcastEvents(tc.broadcast, ...)` so they stay on the raw
  // interop surface, not the typed emit map.
}

type RecalculateCacheKey = 'trustedArtists' | 'batchCache';

export const recalculateTask: TaskDefinition<
  RecalculateEvents,
  RecalculateCacheKey
> = {
  name: 'recalculate',
  path: '/recalculate',
  startMessage: 'Recalculation started',
  caches: [{ key: 'trustedArtists', file: 'trusted-artists.json' }],

  async run(tc: TaskContext<RecalculateEvents, RecalculateCacheKey>) {
    tc.log('info', 'Starting priority recalculation...');

    const userConfig = await tc.userConfig();
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
      tc.log('info', 'Snapshots unchanged — skipping recalculation');
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
    tc.emit('recalc:changes', { changes });

    // Sync unprocessed playlists if P1/P2 boundary crossings occurred.
    // Must complete before persisting, so a failure allows re-running from scratch.
    await syncIfNeeded(
      changes,
      tc.client,
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

    tc.log('success', 'Priorities recalculated and saved');
  },
};
