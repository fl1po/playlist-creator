import { FileConfigStore } from '../lib/config.js';
import { createDurableCache } from '../lib/durable-cache.js';
import { spotifyContext } from '../lib/spotify-context.js';
import { UserConfigStore, secondaryLabel } from '../lib/user-config.js';
import { consoleApiCallbacks } from '../services/playlist-filler/subscribers.js';
import { consoleSyncHandlers } from '../services/promotion-sync/subscribers.js';
import { spotifyRecalculationPorts } from '../services/recalculation/adapters.js';
import { recalculate, syncPending } from '../services/recalculation/index.js';
import {
  consoleRecalculationProgress,
  describeChange,
  syncProgressTo,
} from '../services/recalculation/subscribers.js';

// Usage: pnpm recalculate [--force] [--no-sync]
//   --force    re-score even if neither source playlist changed
//   --no-sync  leave the priority changes pending; the next fill syncs them
const force = process.argv.includes('--force');
const noSync = process.argv.includes('--no-sync');

const DATA_DIR = '.';
const ctx = spotifyContext({
  configStore: new FileConfigStore(),
  events: consoleApiCallbacks(),
});
const userConfig = await new UserConfigStore().load();
const sl = secondaryLabel(userConfig);

const me = await ctx.call(() => ctx.api.currentUser.profile(), 'user profile');
if (!me.success) throw me.error ?? new Error('Failed to get user profile');
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

if (result.outcome === 'unchanged') {
  console.log(
    'Snapshots unchanged — nothing to recalculate (--force to re-score).',
  );
} else {
  const { stats } = result.roster.metadata;
  const t = userConfig.scoring.priorityThresholds;
  console.log('\n=== Priority Distribution ===');
  console.log(`P1 (score >= ${t.p1}): ${stats.p1Count}`);
  console.log(`P2 (score ${t.p2}-${t.p1 - 1}): ${stats.p2Count}`);
  console.log(`P3 (score ${t.p3}-${t.p2 - 1}): ${stats.p3Count}`);
  console.log(`P4 (score ${t.p4}-${t.p3 - 1}): ${stats.p4Count}`);

  console.log('\n=== Top 30 Artists ===');
  const top = Object.entries(result.roster.artistCounts)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 30);
  for (const [name, data] of top) {
    console.log(
      `P${data.priority} [${data.score}] ${name} - AW:${data.allWeekly} ${sl}:${data.bestOfAllWeekly} (recAW:+${data.recencyBonusAW} rec${sl}:+${data.recencyBonusBoAW})`,
    );
  }

  console.log(`\n=== Tier changes (${result.changes.length}) ===`);
  for (const c of result.changes) console.log(`  ${describeChange(c)}`);
}

if (result.pending.length === 0) {
  console.log('\nNo priority changes pending promotion sync.');
} else if (noSync) {
  console.log(
    `\n${result.pending.length} priority change(s) left pending (--no-sync); the next fill syncs them.`,
  );
} else {
  const sync = consoleSyncHandlers();
  const synced = await syncPending(userConfig, deps, syncProgressTo(sync));
  if (synced) sync.onComplete(synced);
}

console.log('\n=== Done! ===\n');
