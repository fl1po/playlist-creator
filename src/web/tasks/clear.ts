import { forgetAiPicks } from '../../services/ai-picks.js';
import {
  describeClear,
  PlaylistClearerService,
} from '../../services/playlist-clearer.js';
import type { TaskDefinition } from '../task-runner.js';

export const clearTask: TaskDefinition = {
  name: 'clear',
  path: '/clear',
  startMessage: 'Clear started',

  validate: (body) =>
    typeof body.name === 'string' && body.name.trim()
      ? undefined
      : 'name is required',

  async run(tc) {
    const name = (tc.body.name as string).trim();
    tc.log('info', `Clearing playlist "${name}"...`);
    const service = new PlaylistClearerService(tc.session.gateway, (e) => {
      for (const l of describeClear(e)) tc.log(l.level, l.message);
    });
    await service.clear(name);
    // A cleared weekly playlist is an unfilled Friday again: its AI picks go.
    await forgetAiPicks(tc.session.data, name);
  },
};
