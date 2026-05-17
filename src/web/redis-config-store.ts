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
