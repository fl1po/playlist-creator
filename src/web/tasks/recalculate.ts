import type { TrustedArtistsFile } from '../../lib/types.js';
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

    const result = await recalculate(tc.session, {
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
    await syncPending(tc.session, (e) => {
      for (const l of describeSync(e)) tc.log(l.level, l.message);
    });
  },
};
