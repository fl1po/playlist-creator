import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyUserData,
  durableUserData,
  localUserData,
  UpstashRedisPort,
  upstashFromEnv,
} from '../lib/user-data/index.js';

/**
 * Copy a user's production user data out of Upstash Redis into the local
 * web-mode data dir (data/users/<userId>/), so the running app can be
 * exercised against real data locally.
 *
 * Usage:  UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *           npm run import-from-redis <spotifyUserId>
 *
 * SAFETY: only set the UPSTASH_* env vars for THIS command. Run `npm run web`
 * WITHOUT them so the local app reads these files instead of talking to (and
 * writing back to) production Redis.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: npm run import-from-redis <spotifyUserId>');
  process.exit(1);
}

const upstash = upstashFromEnv();
if (!upstash) {
  console.error(
    'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the environment.',
  );
  process.exit(1);
}

// An empty data dir, so every load falls through to Redis.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-from-redis-'));
const production = durableUserData({
  userId,
  dataDir: emptyDir,
  redis: new UpstashRedisPort(upstash),
});
const dataDir = path.join(PROJECT_ROOT, 'data', 'users', userId);

console.log(`Importing Redis data for "${userId}" → ${dataDir}\n`);
const copied = await copyUserData(production, localUserData(dataDir));
fs.rmSync(emptyDir, { recursive: true, force: true });
for (const name of copied) console.log(`  ✓ ${name}`);

console.log(
  `\nCopied ${copied.length} dataset(s). Now run \`npm run web\` WITHOUT the` +
    '\nUPSTASH_* env vars so the app uses these local files (and does not write' +
    '\nback to production Redis).',
);
