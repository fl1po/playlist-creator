import type { TrustedArtistsFile } from '../../lib/types.js';
import type { PriorityChange } from '../../services/promotion-sync/index.js';
import { broadcastSyncHandlers } from '../../services/promotion-sync/subscribers.js';
import { spotifyRecalculationPorts } from '../../services/recalculation/adapters.js';
import {
  recalculate,
  syncPending,
} from '../../services/recalculation/index.js';
import {
  broadcastRecalculationProgress,
  syncProgressTo,
} from '../../services/recalculation/subscribers.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface RecalculateEvents extends BaseEvents {
  'recalc:complete': TrustedArtistsFile['metadata']['stats'];
  'recalc:changes': { changes: PriorityChange[] };
  // recalc:scanStart / recalc:scanProgress go out through
  // broadcastRecalculationProgress on the raw tc.broadcast surface.
}

export const recalculateTask: TaskDefinition<RecalculateEvents> = {
  name: 'recalculate',
  path: '/recalculate',
  startMessage: 'Recalculation started',

  async run(tc: TaskContext<RecalculateEvents>) {
    tc.log('info', 'Starting priority recalculation...');

    const userConfig = await tc.userConfig();
    const deps = {
      cache: tc.cache,
      ports: spotifyRecalculationPorts(tc.ctx, {
        userId: tc.userId,
        dataDir: tc.dataDir,
      }),
    };

    const result = await recalculate(userConfig, deps, {
      force: !!tc.body.force,
      onProgress: broadcastRecalculationProgress(tc.broadcast, tc.checkAbort),
    });

    if (result.outcome === 'unchanged') {
      tc.log('info', 'Snapshots unchanged — skipping recalculation');
    } else {
      tc.emit('recalc:complete', result.roster.metadata.stats);
      tc.emit('recalc:changes', { changes: result.changes });
      tc.log('success', 'Priorities recalculated and saved');
    }

    // Runs even when unchanged: it also finishes any sync an earlier
    // recalculation or fill left pending.
    const sync = broadcastSyncHandlers(tc.broadcast);
    const synced = await syncPending(userConfig, deps, syncProgressTo(sync));
    if (synced) sync.onComplete(synced);
  },
};
