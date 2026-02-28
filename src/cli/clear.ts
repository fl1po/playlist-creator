import { FileConfigStore } from "../lib/config.js";
import { createSpotifyClient } from "../lib/spotify-client.js";
import { PlaylistClearerService } from "../services/playlist-clearer.js";

const targetName = process.argv[2];
if (!targetName) {
  console.error("Usage: node build/cli/clear.js <playlist-name>");
  process.exit(1);
}

const configStore = new FileConfigStore();
const client = createSpotifyClient({ configStore });

const service = new PlaylistClearerService(client, {
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
