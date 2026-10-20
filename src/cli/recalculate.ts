import { printLines } from '../lib/task-log.js';
import { secondaryLabel } from '../lib/user-config.js';
import {
  describeRecalculationResult,
  describeSync,
} from '../services/recalculation/describe.js';
import { recalculate, syncPending } from '../services/recalculation/index.js';
import { consoleRecalculationProgress } from '../services/recalculation/subscribers.js';
import { cliSession } from './session.js';

// Usage: pnpm recalculate [--force] [--no-sync]
//   --force    re-score even if neither source playlist changed
//   --no-sync  leave the priority changes pending; the next fill syncs them
const force = process.argv.includes('--force');
const noSync = process.argv.includes('--no-sync');

const session = await cliSession();
const sl = secondaryLabel(await session.data.config.load());

console.log('=== Recalculating Artist Priorities ===\n');

const result = await recalculate(session, {
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
  await syncPending(session, (e) => printLines(describeSync(e)));
}

console.log('\n=== Done! ===\n');
