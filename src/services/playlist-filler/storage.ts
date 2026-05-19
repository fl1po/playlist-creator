import fs from 'node:fs';
import path from 'node:path';
import type { BatchCache, TrustedArtistsFile } from '../../lib/types.js';
import {
  redisSaveBatchCache,
  redisSaveFillHistory,
  redisSaveTrustedArtists,
} from '../../web/redis-config-store.js';

export interface FillHistoryEntry {
  timestamp: string;
  datesProcessed: number;
  datesTotal: number;
  totalTracks: number;
  totalAlbums: number;
  totalSingles: number;
  totalSkipped: number;
  releasesByPriority: Record<string, number>;
}

export interface ProgressFile {
  completed: number;
  total: number;
  lastProcessed?: string;
  results: unknown[];
}

export interface FillStorage {
  loadBatchCache(): Promise<BatchCache>;
  saveBatchCache(c: BatchCache): Promise<void>;
  loadTrustedArtists(): Promise<TrustedArtistsFile>;
  saveTrustedArtists(t: TrustedArtistsFile): Promise<void>;
  appendFillHistory(entry: FillHistoryEntry): Promise<void>;
  saveProgress(p: ProgressFile): Promise<void>;
  /** Absolute path to the data dir (read by sub-services that still need files). */
  readonly dataDir: string;
}

const BATCH_CACHE = 'batch-cache.json';
const TRUSTED_ARTISTS = 'trusted-artists.json';
const FILL_HISTORY = 'fill-history.json';
const PROGRESS = 'batch-p1p2-progress.json';

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

export class FileStorage implements FillStorage {
  constructor(public readonly dataDir: string) {}

  async loadBatchCache(): Promise<BatchCache> {
    return readJson<BatchCache>(path.join(this.dataDir, BATCH_CACHE), {});
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    writeJson(path.join(this.dataDir, BATCH_CACHE), c);
  }
  async loadTrustedArtists(): Promise<TrustedArtistsFile> {
    return JSON.parse(
      fs.readFileSync(path.join(this.dataDir, TRUSTED_ARTISTS), 'utf8'),
    );
  }
  async saveTrustedArtists(t: TrustedArtistsFile): Promise<void> {
    writeJson(path.join(this.dataDir, TRUSTED_ARTISTS), t);
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    const p = path.join(this.dataDir, FILL_HISTORY);
    const history = readJson<unknown[]>(p, []);
    history.push(entry);
    writeJson(p, history);
  }
  async saveProgress(p: ProgressFile): Promise<void> {
    writeJson(path.join(this.dataDir, PROGRESS), p);
  }
}

export interface RedisAndClientHydrate {
  trustedArtists?: unknown;
  batchCache?: unknown;
  fillHistory?: unknown;
}

/**
 * FileStorage decorator that:
 *  - hydrates the data dir from client-provided caches on construction
 *  - mirrors saves to Redis
 *  - emits `data:save` to the client after each save so the browser can persist
 */
export class RedisAndClientStorage implements FillStorage {
  private fs: FileStorage;
  constructor(
    dataDir: string,
    private userId: string,
    hydrate?: RedisAndClientHydrate,
    private emit?: (key: string, value: unknown) => void,
  ) {
    this.fs = new FileStorage(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    if (hydrate?.trustedArtists) {
      writeJson(path.join(dataDir, TRUSTED_ARTISTS), hydrate.trustedArtists);
    }
    if (hydrate?.batchCache) {
      writeJson(path.join(dataDir, BATCH_CACHE), hydrate.batchCache);
    }
    if (hydrate?.fillHistory) {
      writeJson(path.join(dataDir, FILL_HISTORY), hydrate.fillHistory);
    }
  }

  get dataDir(): string {
    return this.fs.dataDir;
  }

  loadBatchCache(): Promise<BatchCache> {
    return this.fs.loadBatchCache();
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    await this.fs.saveBatchCache(c);
    this.emit?.('batchCache', c);
    try {
      await redisSaveBatchCache(this.userId, c);
    } catch {
      /* redis optional */
    }
  }
  loadTrustedArtists(): Promise<TrustedArtistsFile> {
    return this.fs.loadTrustedArtists();
  }
  async saveTrustedArtists(t: TrustedArtistsFile): Promise<void> {
    await this.fs.saveTrustedArtists(t);
    this.emit?.('trustedArtists', t);
    try {
      await redisSaveTrustedArtists(this.userId, t);
    } catch {
      /* redis optional */
    }
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    await this.fs.appendFillHistory(entry);
    const all = readJson<unknown[]>(
      path.join(this.fs.dataDir, FILL_HISTORY),
      [],
    );
    this.emit?.('fillHistory', all);
    try {
      await redisSaveFillHistory(this.userId, all);
    } catch {
      /* redis optional */
    }
  }
  saveProgress(p: ProgressFile): Promise<void> {
    return this.fs.saveProgress(p);
  }
}
