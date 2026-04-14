import fs from 'node:fs';
import path from 'node:path';
import type { TrustedArtistsFile } from '../../lib/types.js';
import {
  PriorityCalculatorService,
  type PriorityCalculatorEventMap,
} from '../../services/priority-calculator.js';
import { broadcastEvents } from '../broadcast.js';
import {
  diffPriorities,
  snapshotPriorities,
  syncIfNeeded,
} from '../priority-diff.js';
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

    const userConfig = tc.userConfigStore.load();

    const service = new PriorityCalculatorService(
      tc.ctx,
      {
        allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
        bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
        scoringWeights: userConfig.scoring,
        priorityThresholds: userConfig.scoring.priorityThresholds,
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

    const output = await service.run();
    fs.writeFileSync(trustedPath, JSON.stringify(output, null, 2));

    const changes = diffPriorities(oldPriorities, output);
    changes.sort(
      (a, b) =>
        (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
    );
    tc.broadcast('recalc:changes', { changes });

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
