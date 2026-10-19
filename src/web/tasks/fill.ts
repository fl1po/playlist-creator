import { aiFindsAvailable } from '../../lib/anthropic-key.js';
import { fillPorts } from '../../services/playlist-filler/adapters.js';
import { runFill } from '../../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../../services/playlist-filler/storage.js';
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

interface FillEvents extends BaseEvents, FillResultEvents {
  'fill:stopped': Record<string, never>;
}

export const fillTask: TaskDefinition<FillEvents> = {
  name: 'fill',
  path: '/fill',
  startMessage: 'Fill started',

  async run(tc: TaskContext<FillEvents>) {
    const freshMode = !!tc.body.fresh;
    tc.log('info', `Starting playlist fill (fresh=${freshMode})...`);

    const userConfig = await tc.userConfig();

    const storage = new DurableFillStorage(tc.cache, tc.dataDir);
    await runFill({
      ctx: tc.ctx,
      userId: tc.userId,
      userConfig,
      storage,
      cache: tc.cache,
      ports: fillPorts(tc.ctx, {
        userId: tc.userId,
        dataDir: tc.dataDir,
        storage,
        cache: tc.cache,
      }),
      onEvent: webFillSink({
        log: tc.log,
        // FillEvents extends FillResultEvents, so this narrows soundly.
        emit: tc.emit as WebFillSinkOptions['emit'],
        progress: tc.progress,
        checkAbort: tc.checkAbort,
      }),
      fresh: freshMode,
      aiFindsAvailable: aiFindsAvailable(),
    });
  },

  // A failure is logged by the runner; a stop still reloads what was filled.
  onError(tc, _error, aborted) {
    if (aborted) tc.emit('fill:stopped', {});
  },
};
