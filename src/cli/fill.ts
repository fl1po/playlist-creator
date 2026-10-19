import { aiFindsAvailable } from '../lib/anthropic-key.js';
import { FileConfigStore } from '../lib/config.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { localUserData } from '../lib/user-data/index.js';
import { fillPorts } from '../services/playlist-filler/adapters.js';
import { runFill } from '../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../services/playlist-filler/storage.js';
import { consoleFillSink } from '../services/playlist-filler/subscribers.js';

const freshMode = process.argv.includes('--fresh');

// The CLI's user data is always local, whatever the env says (ADR-0008).
const data = localUserData('.');
const ctx = createCliGateway({ configStore: new FileConfigStore() });

const me = await ctx.call((api) => api.currentUser.profile(), 'user profile');
if (!me.success) throw me.error;
const userId = me.data.id;
const storage = new DurableFillStorage(data);

await runFill({
  ctx,
  userId,
  userConfig: await data.config.load(),
  storage,
  data,
  ports: fillPorts(ctx, { userId, data, storage }),
  onEvent: consoleFillSink,
  fresh: freshMode,
  aiFindsAvailable: aiFindsAvailable(),
});

console.log('\n=== Done! ===\n');
