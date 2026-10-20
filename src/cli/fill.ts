import { runFill } from '../services/playlist-filler/fill-run.js';
import { consoleFillSink } from '../services/playlist-filler/subscribers.js';
import { cliSession } from './session.js';

const freshMode = process.argv.includes('--fresh');

await runFill({
  ...(await cliSession()),
  onEvent: consoleFillSink,
  fresh: freshMode,
});

console.log('\n=== Done! ===\n');
