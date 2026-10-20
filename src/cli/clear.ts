import { printLines } from '../lib/task-log.js';
import {
  describeClear,
  PlaylistClearerService,
} from '../services/playlist-clearer.js';
import { cliSession } from './session.js';

const targetName = process.argv[2];
if (!targetName) {
  console.error('Usage: node build/cli/clear.js <playlist-name>');
  process.exit(1);
}

const { gateway } = await cliSession();

const service = new PlaylistClearerService(gateway, (e) => {
  printLines(describeClear(e));
  if (e.kind === 'not-found') process.exit(1);
});

await service.clear(targetName);
