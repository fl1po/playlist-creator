import fs from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import { spotifyContext } from '../lib/spotify-context.js';
import { UserConfigStore, secondaryLabel } from '../lib/user-config.js';
import { recalculate } from '../services/recalculate.js';

const ctx = spotifyContext({ configStore: new FileConfigStore() });
const userConfig = new UserConfigStore().load();
const sl = secondaryLabel(userConfig);

console.log('=== Recalculating Artist Priorities ===\n');

const result = await recalculate({
  ctx,
  sources: userConfig.sourcePlaylists,
  scoring: {
    weights: userConfig.scoring,
    thresholds: userConfig.scoring.priorityThresholds,
    featuredMultiplier: userConfig.scoring.featuredMultiplier,
  },
  events: {
    onScanStart: (name) => console.log(`\nScanning ${name}...`),
    onScanProgress: (_name, offset, total) =>
      process.stdout.write(`\r  Fetched ${offset}/${total} tracks`),
    onScanComplete: (_name, artistCount, trackCount) =>
      console.log(
        `\n  Found ${artistCount} unique artists in ${trackCount} tracks`,
      ),
    onCalculationComplete: (stats) => {
      console.log('\n=== Priority Distribution ===');
      console.log(`P1 (score >= 60): ${stats.p1Count}`);
      console.log(`P2 (score 25-59): ${stats.p2Count}`);
      console.log(`P3 (score 15-24): ${stats.p3Count}`);
      console.log(`P4 (score 1-9): ${stats.p4Count}`);
    },
    onTopArtists: (artists) => {
      console.log('\n=== Top 30 Artists ===');
      for (const [name, data] of artists) {
        console.log(
          `P${data.priority} [${data.score}] ${name} - AW:${data.allWeekly} ${sl}:${data.bestOfAllWeekly} (recAW:+${data.recencyBonusAW} rec${sl}:+${data.recencyBonusBoAW})`,
        );
      }
    },
    onSaved: (path) => console.log(`\n=== Saved to ${path} ===`),
  },
});

const outputPath = './trusted-artists.json';
fs.writeFileSync(outputPath, JSON.stringify(result.trustedArtists, null, 2));
console.log(`\n=== Saved to ${outputPath} ===`);
console.log('\n=== Done! ===\n');
