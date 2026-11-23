import { runFill } from '../../services/playlist-filler/fill-run.js';
import {
  type FillResultEvents,
  type WebFillSinkOptions,
  webFillSink,
} from '../../services/playlist-filler/subscribers.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

export interface FillResults extends FillResultEvents {
  /** A stopped fill keeps the weeks it finished, so the page reloads them. */
  'fill:stopped': Record<string, never>;
}
type FillEvents = BaseEvents & FillResults;

export const fillTask: TaskDefinition<FillEvents> = {
  name: 'fill',
  path: '/fill',
  startMessage: (body) =>
    body.fresh ? 'Fill started (fresh)' : 'Fill started',

  async run(tc: TaskContext<FillEvents>) {
    const freshMode = !!tc.body.fresh;

    await runFill({
      ...tc.session,
      onEvent: webFillSink({
        log: tc.log,
        // FillEvents extends FillResultEvents, so this narrows soundly.
        emit: tc.emit as WebFillSinkOptions['emit'],
        progress: tc.progress,
        checkAbort: tc.checkAbort,
      }),
      fresh: freshMode,
    });
  },

  // A failure is logged by the runner; a stop still reloads what was filled.
  onError(tc, _error, aborted) {
    if (aborted) tc.emit('fill:stopped', {});
  },
};
