import {
  describeClear,
  PlaylistClearerService,
} from '../../services/playlist-clearer.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

export interface ClearEvents extends BaseEvents {
  /**
   * The playlist was emptied and its AI picks forgotten, so the page reloads
   * them; the lines are logged (ADR-0007). A not-found or failed clear keeps
   * its picks and sends none.
   */
  'clear:complete': { name: string; cleared: number };
}

export const clearTask: TaskDefinition<ClearEvents> = {
  name: 'clear',
  path: '/clear',
  startMessage: 'Clear started',

  validate: (body) =>
    typeof body.name === 'string' && body.name.trim()
      ? undefined
      : 'name is required',

  async run(tc: TaskContext<ClearEvents>) {
    const name = (tc.body.name as string).trim();
    tc.log('info', `Clearing playlist "${name}"...`);
    const service = new PlaylistClearerService(tc.session, (e) => {
      for (const l of describeClear(e)) tc.log(l.level, l.message);
      if (e.kind === 'cleared') {
        tc.emit('clear:complete', { name: e.name, cleared: e.trackCount });
      }
    });
    await service.clear(name);
  },
};
