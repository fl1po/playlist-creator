import { FileConfigStore } from '../lib/config.js';
import { createDurableCache } from '../lib/durable-cache.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { printLines } from '../lib/task-log.js';
import { secondaryLabel, UserConfigStore } from '../lib/user-config.js';
import { spotifyRecalculationPorts } from '../services/recalculation/adapters.js';
import {
  describeRecalculationResult,
  describeSync,
} from '../services/recalculation/describe.js';
import { recalculate, syncPending } from '../services/recalculation/index.js';
import { consoleRecalculationProgress } from '../services/recalculation/subscribers.js';

// Usage: pnpm recalculate [--force] [--no-sync]
//   --force    re-score even if neither source playlist changed
//   --no-sync  leave the priority changes pending; the next fill syncs them
const force = process.argv.includes('--force');
const noSync = process.argv.includes('--no-sync');

const DATA_DIR = '.';
const ctx = createCliGateway({ configStore: new FileConfigStore() });
const userConfig = await new UserConfigStore().load();
const sl = secondaryLabel(userConfig);

const me = await ctx.call((api) => api.currentUser.profile(), 'user profile');
if (!me.success) throw me.error;
const cache = createDurableCache({
  userId: me.data.id,
  dataDir: DATA_DIR,
  redis: null,
});
const deps = {
  cache,
  ports: spotifyRecalculationPorts(ctx, {
    userId: me.data.id,
    dataDir: DATA_DIR,
  }),
};

console.log('=== Recalculating Artist Priorities ===\n');

const result = await recalculate(userConfig, deps, {
  force,
  onProgress: consoleRecalculationProgress(),
});

printLines(describeRecalculationResult(result));

// A CLI-only report on top of the task log.
if (result.outcome === 'recalculated') {
  console.log('\n=== Top 30 Artists ===');
  const top = Object.entries(result.roster.artistCounts)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 30);
  for (const [name, data] of top) {
    console.log(
      `P${data.priority} [${data.score}] ${name} - AW:${data.allWeekly} ${sl}:${data.bestOfAllWeekly} (recAW:+${data.recencyBonusAW} rec${sl}:+${data.recencyBonusBoAW})`,
    );
  }
}

if (result.pending.length === 0) {
  console.log('\nNo priority changes pending promotion sync.');
} else if (noSync) {
  console.log(
    `\n${result.pending.length} priority change(s) left pending (--no-sync); the next fill syncs them.`,
  );
} else {
  await syncPending(userConfig, deps, (e) => printLines(describeSync(e)));
}

console.log('\n=== Done! ===\n');
