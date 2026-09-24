/**
 * `pnpm year-playlist <year> [--apply] [--rescore] [--fresh] [--allow-degraded]`
 *
 * Two phases, deliberately separate. The collect phase does all the fetching
 * — hours of it, at one Spotify request per second — and writes a plan file
 * plus a Markdown summary. `--apply` reads that plan and writes the monthly
 * playlists without touching a read endpoint.
 *
 * Collection is checkpointed, so an interrupted run resumes where it stopped
 * rather than starting over. The same checkpoint makes `--rescore` cheap:
 * changing scoring constants and rebuilding the plan costs seconds, because
 * every network phase reads from the checkpoint and only the pure scoring
 * runs again.
 *
 * A run that lost calls mid-flight would otherwise produce a plan that looks
 * complete, so writing one requires `--allow-degraded`.
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import { lastfmKeyFromEnv } from '../lib/lastfm-client.js';
import { spotifyContext } from '../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../lib/types.js';
import { applyPlan } from '../services/year-collection/apply.js';
import {
  checkpointPath,
  clearCheckpoint,
} from '../services/year-collection/checkpoint.js';
import {
  loadPlan,
  planPath,
  renderSummary,
  savePlan,
  summaryPath,
} from '../services/year-collection/plan.js';
import { collectYear } from '../services/year-collection/run.js';

const args = process.argv.slice(2);
const year = Number(args.find((a) => /^\d{4}$/.test(a)));
const apply = args.includes('--apply');
const fresh = args.includes('--fresh');
/** Rebuild the plan from checkpointed data — for tuning scoring constants. */
const rescore = args.includes('--rescore');
const allowDegraded = args.includes('--allow-degraded');

if (!Number.isFinite(year)) {
  console.error(
    `Usage: pnpm year-playlist <year> [options]

  --apply            create the playlists from an existing plan
  --rescore          rebuild the plan from checkpointed data (seconds, no refetch)
  --fresh            discard both the plan and the checkpoint, refetch everything
  --allow-degraded   write the plan even if calls were lost mid-run`,
  );
  process.exit(1);
}

const DATA_DIR = '.';
const TRUSTED = './trusted-artists.json';

const ctx = spotifyContext({ configStore: new FileConfigStore() });
const path = planPath(DATA_DIR, year);

// Label of the in-place progress line currently on screen; `log` breaks the
// line before printing so messages don't overwrite it.
let lastLabel = '';
/** Terminal progress that overwrites a single line. */
function progress(label: string, done: number, total: number): void {
  if (label !== lastLabel) {
    if (lastLabel) process.stdout.write('\n');
    lastLabel = label;
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  process.stdout.write(`\r  ${label}: ${done}/${total} (${pct}%)   `);
}

function log(message: string): void {
  if (lastLabel) {
    process.stdout.write('\n');
    lastLabel = '';
  }
  console.log(message);
}

if (apply) {
  const plan = loadPlan(path);
  if (!plan) {
    console.error(
      `No plan found at ${path}. Run "pnpm year-playlist ${year}" first.`,
    );
    process.exit(1);
  }

  const me = await ctx.call(
    () => ctx.api.currentUser.profile(),
    'current user',
  );
  if (!me.success) {
    console.error('Could not identify the current Spotify user.');
    process.exit(1);
  }

  console.log(
    `=== Applying ${year} plan: ${plan.releases.length} releases, ` +
      `${plan.stats.trackTotal} tracks ===\n`,
  );

  const result = await applyPlan(ctx, me.data.id, plan, {
    onPlaylistCreated: (name) => log(`  created ${name}`),
    onPlaylistReused: (name) => log(`  reusing ${name}`),
    onTracksAdded: (name, added, total) => progress(name, added, total),
    onWarning: (message) => log(`  WARNING: ${message}`),
  });

  log('');
  for (const playlist of result.playlists) {
    console.log(
      `  ${playlist.name}  ${String(playlist.releases).padStart(3)} releases  ` +
        `${String(playlist.tracks).padStart(5)} tracks  ${playlist.url}`,
    );
  }
  console.log('\n=== Done ===\n');
} else {
  if (!(fresh || rescore)) {
    const existing = loadPlan(path);
    if (existing) {
      console.log(
        `A plan for ${year} already exists at ${path}.

  --apply     create the playlists from it
  --rescore   rebuild it from checkpointed data after changing scoring constants
  --fresh     discard everything and refetch
`,
      );
      process.exit(0);
    }
  }

  const trustedArtists = JSON.parse(
    readFileSync(TRUSTED, 'utf8'),
  ) as TrustedArtistsFile;

  const cpPath = checkpointPath(DATA_DIR, year);
  if (fresh) clearCheckpoint(cpPath);

  console.log(`=== Collecting ${year} releases ===`);
  console.log(
    'Safe to interrupt — progress is checkpointed and re-running resumes.\n',
  );

  const { plan, degraded } = await collectYear({
    ctx,
    trustedArtists,
    year,
    lastfmKey: lastfmKeyFromEnv(),
    checkpointPath: cpPath,
    log,
    progress,
  });

  log('');

  // A run that lost data mid-flight produces a plan that looks complete. It
  // must not be mistaken for one, so writing it takes an explicit override.
  if (degraded.length > 0 && !allowDegraded) {
    console.error('\nRun completed but lost data:\n');
    for (const phase of degraded) {
      console.error(
        `  ${phase.phase}: ${phase.failures}/${phase.attempts} calls failed ` +
          `(${(phase.rate * 100).toFixed(1)}%)`,
      );
    }
    console.error(
      `\nThe checkpoint is intact, so re-running will retry only what failed:
  pnpm year-playlist ${year}

To write the plan anyway, add --allow-degraded.\n`,
    );
    process.exit(1);
  }

  savePlan(path, plan);
  writeFileSync(summaryPath(DATA_DIR, year), renderSummary(plan));

  console.log(`Plan written to ${path}`);
  console.log(`Summary written to ${summaryPath(DATA_DIR, year)}`);
  console.log(
    `\n${plan.releases.length} releases / ${plan.stats.trackTotal} tracks ` +
      `across ${Object.keys(plan.stats.releasesByMonth).length} months`,
  );
  if (degraded.length > 0) {
    console.log(
      '\nWritten with --allow-degraded; see "Failed calls" in the summary.',
    );
  }
  console.log(
    `\nReview the summary, then run:  pnpm year-playlist ${year} --apply\n`,
  );
}
