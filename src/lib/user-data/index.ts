import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';
import {
  DEFAULT_USER_CONFIG,
  mergeConfigWithDefaults,
  type UserConfig,
} from '../user-config.js';
import { CONFIG, DATASETS, type Dataset } from './datasets.js';

export * from './datasets.js';

/**
 * One user's user data (CONTEXT.md): every dataset, config included. Built
 * once per session or CLI run, in one of two modes:
 * - durable: the file is read first, and Redis keeps the copy that survives
 *   an ephemeral disk. A Redis failure never fails a load or a save.
 * - local: file only.
 * A dataset that isn't there loads as null.
 */
export interface UserData {
  load<T>(dataset: Dataset<T>): Promise<T | null>;
  save<T>(dataset: Dataset<T>, value: T): Promise<void>;
  delete(dataset: Dataset<unknown>): Promise<void>;
  /** Config, merged with the defaults on load. */
  config: {
    load(): Promise<UserConfig>;
    save(config: UserConfig): Promise<void>;
    exists(): Promise<boolean>;
  };
}

/** Dumb string-keyed KV substrate. JSON encoding and key namespacing are the store's job, not the port's. */
export interface RedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export class UpstashRedisPort implements RedisPort {
  constructor(private client: Redis) {}

  async get(key: string): Promise<string | null> {
    const raw = await this.client.get<string>(key);
    if (raw == null) return null;
    // The Upstash client sometimes auto-parses JSON and sometimes returns raw text.
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export class InMemoryRedisPort implements RedisPort {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * The Upstash client from `UPSTASH_REDIS_REST_URL`/`_TOKEN`, or null when
 * they aren't set. Only composition roots call this.
 */
export function upstashFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

/** File first, Redis as the copy that survives a lost disk. */
export function durableUserData(opts: {
  userId: string;
  dataDir: string;
  redis: RedisPort;
}): UserData {
  return createUserData(opts.userId, opts.dataDir, opts.redis);
}

/** Files only; never touches Redis, so no user id is needed. */
export function localUserData(dataDir: string): UserData {
  return createUserData('', dataDir, null);
}

/**
 * Copy every dataset `from` holds into `to`, overwriting what `to` has. A
 * dataset `from` doesn't hold is left alone in `to`. Returns the names copied.
 */
export async function copyUserData(
  from: UserData,
  to: UserData,
): Promise<string[]> {
  const copied: string[] = [];
  for (const dataset of DATASETS) {
    const value = await from.load(dataset);
    if (value === null) continue;
    await to.save(dataset, value);
    copied.push(dataset.name);
  }
  return copied;
}

function defaultIsEmpty<T>(value: T): boolean {
  return value === null || value === undefined;
}

function createUserData(
  userId: string,
  dataDir: string,
  redis: RedisPort | null,
): UserData {
  const key = (dataset: Dataset<unknown>) => `${dataset.name}:${userId}`;
  const filePath = (dataset: Dataset<unknown>) =>
    path.join(dataDir, dataset.file);

  async function load<T>(dataset: Dataset<T>): Promise<T | null> {
    const isEmpty = dataset.isEmpty ?? defaultIsEmpty;

    try {
      const local = JSON.parse(fs.readFileSync(filePath(dataset), 'utf8')) as T;
      if (!isEmpty(local)) return local;
    } catch {
      /* no file yet */
    }

    if (redis) {
      try {
        const raw = await redis.get(key(dataset));
        if (raw !== null) {
          const parsed = JSON.parse(raw) as T;
          if (!isEmpty(parsed)) return parsed;
        }
      } catch {
        /* redis optional */
      }
    }

    return null;
  }

  async function save<T>(dataset: Dataset<T>, value: T): Promise<void> {
    // The local write is authoritative — its failure propagates.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath(dataset), JSON.stringify(value, null, 2));
    if (redis) {
      try {
        await redis.set(key(dataset), JSON.stringify(value));
      } catch {
        /* redis optional */
      }
    }
  }

  async function del(dataset: Dataset<unknown>): Promise<void> {
    try {
      fs.unlinkSync(filePath(dataset));
    } catch {
      /* missing file is fine */
    }
    if (redis) {
      try {
        await redis.del(key(dataset));
      } catch {
        /* redis optional */
      }
    }
  }

  const config = {
    async load(): Promise<UserConfig> {
      const stored = await load(CONFIG);
      return stored
        ? mergeConfigWithDefaults(stored)
        : structuredClone(DEFAULT_USER_CONFIG);
    },
    save: (value: UserConfig) => save(CONFIG, value),
    exists: async () => (await load(CONFIG)) !== null,
  };

  return { load, save, delete: del, config };
}
