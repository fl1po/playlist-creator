import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { DEFAULT_USER_CONFIG } from '../lib/user-config.js';
import {
  AI_PICKS,
  BATCH_CACHE,
  CONFIG,
  copyUserData,
  DATASETS,
  durableUserData,
  FILL_HISTORY,
  InMemoryRedisPort,
  localUserData,
  type RedisPort,
  TRUSTED_ARTISTS,
} from '../lib/user-data/index.js';

const USER = 'user-1';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wipe(dir: string): void {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
}

const roster = {
  artistCounts: { A: { score: 70, priority: 1 } },
} as never;

/** A Redis that fails every call, counting them. */
function brokenRedis(): RedisPort & { calls: number } {
  const port = {
    calls: 0,
    async get(): Promise<string | null> {
      port.calls++;
      throw new Error('redis down');
    },
    async set(): Promise<void> {
      port.calls++;
      throw new Error('redis down');
    },
    async del(): Promise<void> {
      port.calls++;
      throw new Error('redis down');
    },
  };
  return port;
}

// ── Durable mode ────────────────────────────────────────────────────────────

test('durable: a saved dataset survives a wiped disk through Redis', async (t) => {
  const dir = tempDir(t);
  const redis = new InMemoryRedisPort();
  const data = durableUserData({ userId: USER, dataDir: dir, redis });

  await data.save(TRUSTED_ARTISTS, roster);
  wipe(dir);

  const after = durableUserData({ userId: USER, dataDir: dir, redis });
  assert.deepEqual(await after.load(TRUSTED_ARTISTS), roster);
});

test('durable: the file wins over Redis', async (t) => {
  const dir = tempDir(t);
  const redis = new InMemoryRedisPort();
  await redis.set('fillHistory:user-1', JSON.stringify(['redis']));
  fs.writeFileSync(path.join(dir, FILL_HISTORY.file), JSON.stringify(['file']));

  const data = durableUserData({ userId: USER, dataDir: dir, redis });
  assert.deepEqual(await data.load(FILL_HISTORY), ['file']);
});

test('durable: an empty file falls through to Redis', async (t) => {
  const dir = tempDir(t);
  const redis = new InMemoryRedisPort();
  await redis.set('batchCache:user-1', JSON.stringify({ x: 1 }));
  fs.writeFileSync(path.join(dir, BATCH_CACHE.file), '{}');

  const data = durableUserData({ userId: USER, dataDir: dir, redis });
  assert.deepEqual(await data.load(BATCH_CACHE), { x: 1 });
});

test('durable: Redis keys are namespaced per user', async (t) => {
  const redis = new InMemoryRedisPort();
  const a = durableUserData({ userId: 'a', dataDir: tempDir(t), redis });
  const b = durableUserData({ userId: 'b', dataDir: tempDir(t), redis });

  await a.save(FILL_HISTORY, ['a']);
  assert.equal(await b.load(FILL_HISTORY), null);
});

test('durable: a Redis failure never fails a load or a save', async (t) => {
  const dir = tempDir(t);
  const redis = brokenRedis();
  const data = durableUserData({ userId: USER, dataDir: dir, redis });

  assert.equal(await data.load(FILL_HISTORY), null);
  await data.save(FILL_HISTORY, ['x']);
  assert.deepEqual(await data.load(FILL_HISTORY), ['x']);
  await data.delete(FILL_HISTORY);
  assert.equal(await data.load(FILL_HISTORY), null);
  assert.ok(redis.calls > 0);
});

test('durable: delete removes both copies', async (t) => {
  const dir = tempDir(t);
  const redis = new InMemoryRedisPort();
  const data = durableUserData({ userId: USER, dataDir: dir, redis });

  await data.save(FILL_HISTORY, ['x']);
  await data.delete(FILL_HISTORY);

  assert.equal(await data.load(FILL_HISTORY), null);
  assert.equal(await redis.get('fillHistory:user-1'), null);
});

// ── Local mode ──────────────────────────────────────────────────────────────

test('local: never touches Redis, so a wiped disk loses the data', async (t) => {
  const dir = tempDir(t);
  const data = localUserData(dir);

  await data.save(TRUSTED_ARTISTS, roster);
  assert.deepEqual(await data.load(TRUSTED_ARTISTS), roster);

  wipe(dir);
  assert.equal(await data.load(TRUSTED_ARTISTS), null);
});

// ── Config ──────────────────────────────────────────────────────────────────

test('config: defaults until saved, then merged with the defaults', async (t) => {
  const data = localUserData(tempDir(t));

  assert.equal(await data.config.exists(), false);
  assert.deepEqual(await data.config.load(), DEFAULT_USER_CONFIG);

  // A config saved before a field existed still loads with that field.
  await data.save(CONFIG, { weeklyListeningBudget: 7 });
  assert.equal(await data.config.exists(), true);
  const loaded = await data.config.load();
  assert.equal(loaded.weeklyListeningBudget, 7);
  assert.deepEqual(loaded.aiFinds, DEFAULT_USER_CONFIG.aiFinds);
});

test('config: kept under config:<user> in Redis, readable after a wiped disk', async (t) => {
  const dir = tempDir(t);
  const redis = new InMemoryRedisPort();
  const data = durableUserData({ userId: USER, dataDir: dir, redis });

  const config = { ...DEFAULT_USER_CONFIG, weeklyListeningBudget: 9 };
  await data.config.save(config);
  wipe(dir);

  assert.ok(await redis.get('config:user-1'));
  assert.equal((await data.config.load()).weeklyListeningBudget, 9);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('copy: moves every dataset the source holds, from production to local', async (t) => {
  const redis = new InMemoryRedisPort();
  const production = durableUserData({
    userId: USER,
    dataDir: tempDir(t),
    redis,
  });
  for (const dataset of DATASETS) {
    await production.save(dataset, [dataset.name]);
  }
  const local = localUserData(tempDir(t));

  const copied = await copyUserData(production, local);

  assert.deepEqual(
    copied,
    DATASETS.map((d) => d.name),
  );
  for (const dataset of DATASETS) {
    assert.deepEqual(await local.load(dataset), [dataset.name]);
  }
});

test('copy: a dataset the source lacks is left alone at the target', async (t) => {
  const source = localUserData(tempDir(t));
  const target = localUserData(tempDir(t));
  await source.save(FILL_HISTORY, ['new']);
  await target.save(FILL_HISTORY, ['old']);
  await target.save(AI_PICKS, { '01.01.26': { skipped: 'x' } } as never);

  assert.deepEqual(await copyUserData(source, target), ['fillHistory']);
  assert.deepEqual(await target.load(FILL_HISTORY), ['new']);
  assert.deepEqual(await target.load(AI_PICKS), {
    '01.01.26': { skipped: 'x' },
  });
});
