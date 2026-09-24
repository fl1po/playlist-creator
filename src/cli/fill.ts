import { FileConfigStore } from '../lib/config.js';
import { createDurableCache } from '../lib/durable-cache.js';
import { spotifyContext } from '../lib/spotify-context.js';
import { UserConfigStore } from '../lib/user-config.js';
import { runFill } from '../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../services/playlist-filler/storage.js';
import {
  consoleApiCallbacks,
  consoleHandlers,
} from '../services/playlist-filler/subscribers.js';
import { consoleSyncHandlers } from '../services/promotion-sync/subscribers.js';
import { spotifyRecalculationPorts } from '../services/recalculation/adapters.js';

const freshMode = process.argv.includes('--fresh');

const DATA_DIR = '.';
const ctx = spotifyContext({
  configStore: new FileConfigStore(),
  events: consoleApiCallbacks(),
});

const me = await ctx.call(() => ctx.api.currentUser.profile(), 'user profile');
if (!me.success) throw me.error ?? new Error('Failed to get user profile');
const cache = createDurableCache({
  userId: me.data.id,
  dataDir: DATA_DIR,
  redis: null,
});

await runFill({
  ctx,
  userConfig: await new UserConfigStore().load(),
  storage: new DurableFillStorage(cache, DATA_DIR),
  recalculation: {
    cache,
    ports: spotifyRecalculationPorts(ctx, {
      userId: me.data.id,
      dataDir: DATA_DIR,
    }),
  },
  handlers: consoleHandlers(),
  syncHandlers: consoleSyncHandlers(),
  fresh: freshMode,
});

console.log('\nResults saved to: batch-p1p2-progress.json');
console.log('\n=== Done! ===\n');
