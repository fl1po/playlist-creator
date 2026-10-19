import type { TrustedArtistsFile } from '../../lib/types.js';
import type { PriorityChange } from '../../services/promotion-sync/index.js';
import { spotifyRecalculationPorts } from '../../services/recalculation/adapters.js';
import { describeSync } from '../../services/recalculation/describe.js';
import {
  recalculate,
  syncPending,
} from '../../services/recalculation/index.js';
import { broadcastRecalculationProgress } from '../../services/recalculation/subscribers.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface RecalculateEvents extends BaseEvents {
  'recalc:complete': TrustedArtistsFile['metadata']['stats'];
  'recalc:changes': { changes: PriorityChange[] };
  // recalc:scanStart goes out through broadcastRecalculationProgress on the
  // raw tc.broadcast surface; scan progress goes through tc.progress.
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
      onProgress: broadcastRecalculationProgress(
        tc.broadcast,
        tc.progress,
        tc.checkAbort,
      ),
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
    await syncPending(userConfig, deps, (e) => {
      for (const l of describeSync(e)) tc.log(l.level, l.message);
    });
  },
};
