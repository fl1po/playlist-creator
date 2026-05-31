import { FileConfigStore } from '../lib/config.js';
import { spotifyContext } from '../lib/spotify-context.js';
import { runFill } from '../services/playlist-filler/fill-run.js';
import { writeProgressFile } from '../services/playlist-filler/post.js';
import { FileStorage } from '../services/playlist-filler/storage.js';
import {
  consoleApiCallbacks,
  consoleHandlers,
} from '../services/playlist-filler/subscribers.js';

const freshMode = process.argv.includes('--fresh');

const ctx = spotifyContext({
  configStore: new FileConfigStore(),
  events: consoleApiCallbacks(),
});

const storage = new FileStorage('.');
const result = await runFill({
  ctx,
  config: { freshMode },
  storage,
  handlers: consoleHandlers(),
  fresh: freshMode,
});

await writeProgressFile(storage, result);

console.log('\nResults saved to: batch-p1p2-progress.json');
console.log('\n=== Done! ===\n');
