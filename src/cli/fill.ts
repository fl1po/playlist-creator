import fs from 'node:fs';
import { FileConfigStore } from '../lib/config.js';
import { spotifyContext } from '../lib/spotify-context.js';
import {
  ConsolePresenter,
  FileStorage,
  runFill,
} from '../services/playlist-filler/index.js';

const freshMode = process.argv.includes('--fresh');

const ctx = spotifyContext({
  configStore: new FileConfigStore(),
  events: ConsolePresenter.apiCallbacks(),
});

const { results } = await runFill({
  ctx,
  config: { freshMode },
  storage: new FileStorage('.'),
  presenter: new ConsolePresenter(),
  fresh: freshMode,
});

fs.writeFileSync(
  './batch-p1p2-progress.json',
  JSON.stringify(
    {
      completed: results.filter((r) => !r.error).length,
      total: results.length,
      lastProcessed: results[results.length - 1]?.date,
      results,
    },
    null,
    2,
  ),
);

console.log('\nResults saved to: batch-p1p2-progress.json');
console.log('\n=== Done! ===\n');
