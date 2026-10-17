import { Redis } from '@upstash/redis';

/**
 * Durable home of the live log, so it survives deploys. The broadcaster
 * batches entries into `append` and reads a user's recent ones back on boot.
 */

/** One history entry as the broadcaster replays it: its SSE id, time and frame. */
export interface StoredEntry {
  seq: number;
  ts: number;
  msg: string;
}

export interface LogStore {
  append(userId: string, entries: StoredEntry[]): Promise<void>;
  /** The user's entries since `sinceMs`, oldest first. */
  load(userId: string, sinceMs: number): Promise<StoredEntry[]>;
  /** Every user with a stored log. */
  users(): Promise<string[]>;
  clear(userId: string): Promise<void>;
}

// ── Upstash ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day's key outlives the week it serves by a day, then Redis drops it. */
const KEY_TTL_S = 8 * 24 * 60 * 60;
/** Entries per RPUSH, keeping each request well under Upstash's size cap. */
const CHUNK = 200;
const USERS_KEY = 'log:users';

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const dayKey = (userId: string, day: string) => `log:${userId}:${day}`;

/** Day keys from `sinceMs`'s day through today. */
function daysSince(sinceMs: number, nowMs: number): string[] {
  const days: string[] = [];
  for (let t = sinceMs; dayOf(t) <= dayOf(nowMs); t += DAY_MS) {
    days.push(dayOf(t));
  }
  return days;
}

/** The client may hand back a stored string already parsed as JSON. */
function parseEntry(raw: unknown): StoredEntry {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as StoredEntry;
}

/** One list per user per UTC day, each expiring a day after its week is up. */
export function upstashLogStore(
  redis: Redis,
  now: () => number = Date.now,
): LogStore {
  return {
    async append(userId, entries) {
      const byDay = new Map<string, string[]>();
      for (const e of entries) {
        const day = dayOf(e.ts);
        byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
      }
      const p = redis.pipeline();
      for (const [day, values] of byDay) {
        const key = dayKey(userId, day);
        for (let i = 0; i < values.length; i += CHUNK) {
          p.rpush(key, ...values.slice(i, i + CHUNK));
        }
        p.expire(key, KEY_TTL_S);
      }
      p.sadd(USERS_KEY, userId);
      await p.exec();
    },

    async load(userId, sinceMs) {
      const p = redis.pipeline();
      for (const day of daysSince(sinceMs, now())) {
        p.lrange(dayKey(userId, day), 0, -1);
      }
      const lists = (await p.exec()) as unknown[][];
      return lists
        .flat()
        .map(parseEntry)
        .filter((e) => e.ts >= sinceMs)
        .sort((a, b) => a.seq - b.seq);
    },

    async users() {
      return redis.smembers(USERS_KEY);
    },

    async clear(userId) {
      const keys = daysSince(now() - KEY_TTL_S * 1000, now()).map((day) =>
        dayKey(userId, day),
      );
      await redis.del(...keys);
    },
  };
}

/** The production store, or null when Redis isn't configured. */
export function productionLogStore(): LogStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!(url && token)) return null;
  return upstashLogStore(new Redis({ url, token }));
}

// ── Memory ───────────────────────────────────────────────────────────────────

/** In-memory LogStore for tests: one list per user. */
export function memoryLogStore(): LogStore {
  const logs = new Map<string, StoredEntry[]>();
  return {
    async append(userId, entries) {
      logs.set(userId, [...(logs.get(userId) ?? []), ...entries]);
    },
    async load(userId, sinceMs) {
      return (logs.get(userId) ?? []).filter((e) => e.ts >= sinceMs);
    },
    async users() {
      return [...logs.keys()];
    },
    async clear(userId) {
      logs.delete(userId);
    },
  };
}
