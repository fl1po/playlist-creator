import { FileConfigStore } from '../lib/config.js';
import { createDurableCache } from '../lib/durable-cache.js';
import { spotifyContext } from '../lib/spotify-context.js';
import { UserConfigStore } from '../lib/user-config.js';
import { fillPorts } from '../services/playlist-filler/adapters.js';
import { runFill } from '../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../services/playlist-filler/storage.js';
import {
  consoleApiCallbacks,
  consoleHandlers,
} from '../services/playlist-filler/subscribers.js';
import { consoleSyncHandlers } from '../services/promotion-sync/subscribers.js';

const freshMode = process.argv.includes('--fresh');

const DATA_DIR = '.';
const ctx = spotifyContext({
  configStore: new FileConfigStore(),
  events: consoleApiCallbacks(),
});

const me = await ctx.call(() => ctx.api.currentUser.profile(), 'user profile');
if (!me.success) throw me.error ?? new Error('Failed to get user profile');
const userId = me.data.id;
const cache = createDurableCache({ userId, dataDir: DATA_DIR, redis: null });
const storage = new DurableFillStorage(cache, DATA_DIR);

await runFill({
  ctx,
  userId,
  userConfig: await new UserConfigStore().load(),
  storage,
  cache,
  ports: fillPorts(ctx, { userId, dataDir: DATA_DIR, storage }),
  handlers: consoleHandlers(),
  syncHandlers: consoleSyncHandlers(),
  fresh: freshMode,
});

console.log('\nResults saved to: batch-p1p2-progress.json');
console.log('\n=== Done! ===\n');
