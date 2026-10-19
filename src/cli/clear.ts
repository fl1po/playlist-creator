import { FileConfigStore } from '../lib/config.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { printLines } from '../lib/task-log.js';
import {
  describeClear,
  PlaylistClearerService,
} from '../services/playlist-clearer.js';

const targetName = process.argv[2];
if (!targetName) {
  console.error('Usage: node build/cli/clear.js <playlist-name>');
  process.exit(1);
}

const ctx = createCliGateway({ configStore: new FileConfigStore() });

const service = new PlaylistClearerService(ctx, (e) => {
  printLines(describeClear(e));
  if (e.kind === 'not-found') process.exit(1);
});

await service.clear(targetName);
