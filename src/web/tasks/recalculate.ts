import type { TrustedArtistsFile } from '../../lib/types.js';
import { spotifyRecalculationPorts } from '../../services/recalculation/adapters.js';
import {
  describeRecalculationResult,
  describeSync,
} from '../../services/recalculation/describe.js';
import {
  recalculate,
  syncPending,
} from '../../services/recalculation/index.js';
import { webRecalculationProgress } from '../../services/recalculation/subscribers.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface RecalculateEvents extends BaseEvents {
  /** For the page to reload the roster; the lines are logged (ADR-0007). */
  'recalc:complete': TrustedArtistsFile['metadata']['stats'];
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
      onProgress: webRecalculationProgress(tc),
    });

    for (const l of describeRecalculationResult(result)) {
      tc.log(l.level, l.message);
    }
    if (result.outcome === 'recalculated') {
      tc.emit('recalc:complete', result.roster.metadata.stats);
    }

    // Runs even when unchanged: it also finishes any sync an earlier
    // recalculation or fill left pending.
    await syncPending(userConfig, deps, (e) => {
      for (const l of describeSync(e)) tc.log(l.level, l.message);
    });
  },
};
