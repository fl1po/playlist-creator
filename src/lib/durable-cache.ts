import fs from 'node:fs';
import path from 'node:path';
import { Redis } from '@upstash/redis';

/** Dumb string-keyed KV substrate. JSON encoding and key namespacing are DurableCache's job, not the port's. */
export interface RedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface CacheDescriptor<T> {
  /** Redis key prefix; final key is `${redisName}:${userId}`. */
  readonly redisName: string;
  /** Filename inside the user's (ephemeral) data dir. */
  readonly file: string;
  /**
   * A value that parsed fine but must still be treated as "no cache" (e.g.
   * `{}` for batchCache, which should fall through to Redis). Defaults to
   * `value == null`.
   */
  isEmpty?(value: T): boolean;
}

export interface DurableCache {
  load<T>(descriptor: CacheDescriptor<T>): Promise<T | null>;
  save<T>(descriptor: CacheDescriptor<T>, value: T): Promise<void>;
  delete(descriptor: CacheDescriptor<unknown>): Promise<void>;
  /** Parallel batch read, for callers that need several keys at once (e.g. an export route). */
  loadMany<D extends Record<string, CacheDescriptor<unknown>>>(
    descriptors: D,
  ): Promise<{ [K in keyof D]: DescriptorValue<D[K]> | null }>;
}

type DescriptorValue<D> = D extends CacheDescriptor<infer T> ? T : never;

export function isRedisConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
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

let productionPort: UpstashRedisPort | null = null;

function getProductionRedisPort(): RedisPort | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!(url && token)) return null;
  productionPort ??= new UpstashRedisPort(new Redis({ url, token }));
  return productionPort;
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

function defaultIsEmpty<T>(value: T): boolean {
  return value === null || value === undefined;
}

function readLocal<T>(dataDir: string, file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeLocal(dataDir: string, file: string, value: unknown): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2));
}

export function createDurableCache(opts: {
  userId: string;
  dataDir: string;
  /** Test/composition-root seam. Omit to use the production Upstash-backed port (or none, if unconfigured). */
  redis?: RedisPort | null;
}): DurableCache {
  const { userId, dataDir } = opts;
  const redis =
    opts.redis === undefined ? getProductionRedisPort() : opts.redis;

  async function load<T>(descriptor: CacheDescriptor<T>): Promise<T | null> {
    const isEmpty = descriptor.isEmpty ?? defaultIsEmpty;

    const local = readLocal<T>(dataDir, descriptor.file);
    if (local !== null && !isEmpty(local)) return local;

    if (redis) {
      try {
        const raw = await redis.get(`${descriptor.redisName}:${userId}`);
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

  async function save<T>(
    descriptor: CacheDescriptor<T>,
    value: T,
  ): Promise<void> {
    writeLocal(dataDir, descriptor.file, value); // local write is authoritative — its failure propagates
    if (redis) {
      try {
        await redis.set(
          `${descriptor.redisName}:${userId}`,
          JSON.stringify(value),
        );
      } catch {
        /* redis optional */
      }
    }
  }

  async function del(descriptor: CacheDescriptor<unknown>): Promise<void> {
    try {
      fs.unlinkSync(path.join(dataDir, descriptor.file));
    } catch {
      /* missing file is fine */
    }
    if (redis) {
      try {
        await redis.del(`${descriptor.redisName}:${userId}`);
      } catch {
        /* redis optional */
      }
    }
  }

  async function loadMany<D extends Record<string, CacheDescriptor<unknown>>>(
    descriptors: D,
  ): Promise<{ [K in keyof D]: DescriptorValue<D[K]> | null }> {
    const keys = Object.keys(descriptors) as Array<keyof D>;
    const values = await Promise.all(keys.map((k) => load(descriptors[k])));
    const result = {} as { [K in keyof D]: DescriptorValue<D[K]> | null };
    keys.forEach((k, i) => {
      result[k] = values[i] as DescriptorValue<D[typeof k]> | null;
    });
    return result;
  }

  return { load, save, delete: del, loadMany };
}
