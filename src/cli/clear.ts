import { FileConfigStore } from '../lib/config.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { PlaylistClearerService } from '../services/playlist-clearer.js';

const targetName = process.argv[2];
if (!targetName) {
  console.error('Usage: node build/cli/clear.js <playlist-name>');
  process.exit(1);
}

const ctx = createCliGateway({ configStore: new FileConfigStore() });

const service = new PlaylistClearerService(ctx, {
  onPlaylistFound: (name, count) =>
    console.log(`Found: ${name} (${count} tracks)`),
  onPlaylistNotFound: (name) => {
    console.error(`Playlist "${name}" not found`);
    process.exit(1);
  },
  onCleared: (name, count) =>
    console.log(`Cleared ${count} tracks from "${name}"`),
});

await service.clear(targetName);
