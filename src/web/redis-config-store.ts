import { Redis } from '@upstash/redis';
import {
  DEFAULT_USER_CONFIG,
  type IUserConfigStore,
  type UserConfig,
  mergeConfigWithDefaults,
} from '../lib/user-config.js';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

export class RedisUserConfigStore implements IUserConfigStore {
  private key: string;

  constructor(userId: string) {
    this.key = `config:${userId}`;
  }

  async exists(): Promise<boolean> {
    const result = await getRedis().exists(this.key);
    return result === 1;
  }

  async load(): Promise<UserConfig> {
    const raw = await getRedis().get<Partial<UserConfig>>(this.key);
    if (!raw) return structuredClone(DEFAULT_USER_CONFIG);
    return mergeConfigWithDefaults(raw);
  }

  async save(config: UserConfig): Promise<void> {
    await getRedis().set(this.key, config);
  }
}

export function isRedisConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// ── Trusted Artists Redis Store ─────────────────────────────────────────────

export async function redisSaveTrustedArtists(
  userId: string,
  data: unknown,
): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().set(`trustedArtists:${userId}`, JSON.stringify(data));
}

export async function redisLoadTrustedArtists(
  userId: string,
): Promise<unknown | null> {
  if (!isRedisConfigured()) return null;
  const raw = await getRedis().get<string>(`trustedArtists:${userId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Fill History Redis Store ────────────────────────────────────────────────

export async function redisSaveFillHistory(
  userId: string,
  data: unknown,
): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().set(`fillHistory:${userId}`, JSON.stringify(data));
}

export async function redisLoadFillHistory(
  userId: string,
): Promise<unknown[] | null> {
  if (!isRedisConfigured()) return null;
  const raw = await getRedis().get<string>(`fillHistory:${userId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Batch Cache Redis Store ────────────────────────────────────────────────

export async function redisSaveBatchCache(
  userId: string,
  data: unknown,
): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().set(`batchCache:${userId}`, JSON.stringify(data));
}

export async function redisLoadBatchCache(
  userId: string,
): Promise<unknown | null> {
  if (!isRedisConfigured()) return null;
  const raw = await getRedis().get<string>(`batchCache:${userId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Generic per-user JSON cache ─────────────────────────────────────────────
// Used for the regenerable analytics caches (durationSnapshots / listeningTime /
// awBreakdown) so they survive an ephemeral filesystem the same way the core
// datasets do. `name` is the key prefix, e.g. `durationSnapshots:<userId>`.

export async function redisSaveCache(
  userId: string,
  name: string,
  data: unknown,
): Promise<void> {
  if (!isRedisConfigured()) return;
  await getRedis().set(`${name}:${userId}`, JSON.stringify(data));
}

export async function redisLoadCache<T = unknown>(
  userId: string,
  name: string,
): Promise<T | null> {
  if (!isRedisConfigured()) return null;
  const raw = await getRedis().get<string>(`${name}:${userId}`);
  if (!raw) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
}
