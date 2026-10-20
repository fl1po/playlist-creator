import { aiFindsAvailable } from '../lib/anthropic-key.js';
import { fillPorts } from '../services/playlist-filler/adapters.js';
import { runFill } from '../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../services/playlist-filler/storage.js';
import { consoleFillSink } from '../services/playlist-filler/subscribers.js';
import { cliSession } from './session.js';

const freshMode = process.argv.includes('--fresh');

const { gateway: ctx, userId, data } = await cliSession();
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
