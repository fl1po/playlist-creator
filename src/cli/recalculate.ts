import fs from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyClient } from '../lib/spotify-client.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import { PriorityCalculatorService } from '../services/priority-calculator.js';

const configStore = new FileConfigStore();
const client = createSpotifyClient({ configStore });

const pacer = new RequestPacer(1);
const ctx = createSpotifyContext(client, undefined, pacer);

const service = new PriorityCalculatorService(
  ctx,
  {},
  {
    onScanStart: (name) => console.log(`\nScanning ${name}...`),
    onScanComplete: (_name, artistCount, trackCount) =>
      console.log(
        `  Found ${artistCount} unique artists in ${trackCount} tracks`,
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
          `P${data.priority} [${data.score}] ${name} - AW:${data.allWeekly} BoAW:${data.bestOfAllWeekly} (recAW:+${data.recencyBonusAW} recBoAW:+${data.recencyBonusBoAW})`,
        );
      }
    },
    onSaved: (path) => console.log(`\n=== Saved to ${path} ===`),
  },
);

console.log('=== Recalculating Artist Priorities ===\n');

const output = await service.run();

const outputPath = './trusted-artists.json';
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\n=== Saved to ${outputPath} ===`);
console.log('\n=== Done! ===\n');
