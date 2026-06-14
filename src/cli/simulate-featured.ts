import fs from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import {
  getLikedTracksWithPositions,
  getPlaylistTracksWithPositions,
} from '../lib/pagination.js';
import { spotifyContext } from '../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../lib/types.js';
import { UserConfigStore, secondarySourceName } from '../lib/user-config.js';
import {
  type ReportContext,
  renderReport,
  simulate,
} from '../services/featured-simulation.js';

// ── Parse multiplier ──────────────────────────────────────────────────────────

const rawArg = process.argv[2];
const multiplier = rawArg === undefined ? 0.5 : Number(rawArg);
if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1) {
  console.error(
    `Invalid multiplier "${rawArg}". Provide a number between 0 and 1 (default 0.5).`,
  );
  process.exit(1);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const ctx = spotifyContext({ configStore: new FileConfigStore() });
const userConfig = new UserConfigStore().load();
const secondaryName = secondarySourceName(userConfig);

console.log('=== Featured-artist gain simulation (read-only) ===');
console.log(`Multiplier: ${multiplier}x  (1.0 = no change)\n`);

const progressFor = (name: string) => ({
  onProgress: (fetched: number, total: number) =>
    process.stdout.write(`\r  ${name}: fetched ${fetched}/${total} tracks`),
});

// ── Scan (live) ───────────────────────────────────────────────────────────────

console.log('Scanning All Weekly...');
const awScan = await getPlaylistTracksWithPositions(
  ctx,
  userConfig.sourcePlaylists.allWeeklyId,
  progressFor('All Weekly'),
);
console.log(
  `\n  ${awScan.artistData.size} artists in ${awScan.totalTracks} tracks`,
);

console.log(`Scanning ${secondaryName}...`);
const boawScan = userConfig.sourcePlaylists.useLikedSongs
  ? await getLikedTracksWithPositions(ctx, progressFor(secondaryName))
  : await getPlaylistTracksWithPositions(
      ctx,
      userConfig.sourcePlaylists.bestOfAllWeeklyId,
      progressFor(secondaryName),
    );
console.log(
  `\n  ${boawScan.artistData.size} artists in ${boawScan.totalTracks} tracks\n`,
);

// ── Simulate ──────────────────────────────────────────────────────────────────

const result = simulate(
  awScan,
  boawScan,
  multiplier,
  userConfig.scoring,
  userConfig.scoring.priorityThresholds,
);

// Drift note: compare the fresh 1.0x baseline against what's stored live.
let driftNote: string | undefined;
const storedPath = './trusted-artists.json';
if (fs.existsSync(storedPath)) {
  try {
    const stored = JSON.parse(
      fs.readFileSync(storedPath, 'utf8'),
    ) as TrustedArtistsFile;
    const b = result.summary.baseTierCounts;
    const s = stored.metadata.stats;
    driftNote = `Drift vs stored trusted-artists.json (lastFullAnalysis ${stored.metadata.lastFullAnalysis}): P1 ${s.p1Count}→${b.p1}, P2 ${s.p2Count}→${b.p2} (fresh 1.0x re-scan vs stored; differences are playlist drift, not the multiplier).`;
  } catch {
    driftNote = undefined;
  }
}

const reportCtx: ReportContext = {
  secondaryName,
  awTotal: awScan.totalTracks,
  boawTotal: boawScan.totalTracks,
  driftNote,
  generatedAt: new Date().toISOString(),
};

const report = renderReport(result, reportCtx);

// ── Output ────────────────────────────────────────────────────────────────────

console.log(`\n${report}`);

const outputPath = './featured-simulation.md';
fs.writeFileSync(outputPath, report);
console.log(`\n=== Report written to ${outputPath} ===`);
console.log('=== trusted-artists.json was NOT modified ===\n');
