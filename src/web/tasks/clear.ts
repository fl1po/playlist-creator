import { broadcastEvents } from '../../lib/service-events.js';
import {
  type PlaylistClearerEventMap,
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
    // clear:complete goes out through broadcastEvents, so it uses the
    // untyped tc.broadcast like the other service-event tasks.
    const service = new PlaylistClearerService(
      tc.ctx,
      broadcastEvents<PlaylistClearerEventMap>(tc.broadcast, {
        playlistFound: {
          log: (n, count) => `Found "${n}" (${count} tracks)`,
        },
        playlistNotFound: {
          log: (n) => `Playlist "${n}" not found`,
          level: 'warn',
        },
        cleared: {
          type: 'clear:complete',
          pack: (n, count) => ({ name: n, cleared: count }),
        },
      }),
    );
    await service.clear(name);
  },
};
