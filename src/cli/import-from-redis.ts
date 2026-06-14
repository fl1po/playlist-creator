import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from '@upstash/redis';

/**
 * Pull a user's deployment state out of Upstash Redis into the local web-mode
 * data dir (data/users/<userId>/), so the running app can be exercised against
 * real data locally.
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

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!(url && token)) {
  console.error(
    'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the environment.',
  );
  process.exit(1);
}

const redis = new Redis({ url, token });

const dataDir = path.join(PROJECT_ROOT, 'data', 'users', userId);
fs.mkdirSync(dataDir, { recursive: true });

// Redis key → local filename. Web mode reads these from data/users/<userId>/.
const MAP: Array<{ key: string; file: string }> = [
  { key: `config:${userId}`, file: 'user-config.json' },
  { key: `trustedArtists:${userId}`, file: 'trusted-artists.json' },
  { key: `batchCache:${userId}`, file: 'batch-cache.json' },
  { key: `fillHistory:${userId}`, file: 'fill-history.json' },
];

/** Values are stored either as objects (config) or JSON strings (the rest). */
function normalize(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

console.log(`Importing Redis data for "${userId}" → ${dataDir}\n`);

for (const { key, file } of MAP) {
  const raw = await redis.get(key);
  if (raw == null) {
    console.log(`  - ${key}: (empty) — skipped`);
    continue;
  }
  const value = normalize(raw);
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2));
  const summary = Array.isArray(value)
    ? `${value.length} items`
    : `${(JSON.stringify(value).length / 1024).toFixed(1)} KB`;
  console.log(`  ✓ ${key} → data/users/${userId}/${file} (${summary})`);
}

console.log(
  '\nDone. Now run `npm run web` WITHOUT the UPSTASH_* env vars so the app uses' +
    '\nthese local files (and does not write back to production Redis), then' +
    '\ntrigger a recalculation to test the demotion sync.',
);
