import fs from 'node:fs';
import path from 'node:path';
import {
  BATCH_CACHE,
  FILL_HISTORY,
  TRUSTED_ARTISTS,
} from '../../lib/cache-files.js';
import { createDurableCache } from '../../lib/durable-cache.js';
import type { DurableCache } from '../../lib/durable-cache.js';
import type { BatchCache, TrustedArtistsFile } from '../../lib/types.js';

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
    return readJson<BatchCache>(path.join(this.dataDir, BATCH_CACHE.file), {});
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    writeJson(path.join(this.dataDir, BATCH_CACHE.file), c);
  }
  async loadTrustedArtists(): Promise<TrustedArtistsFile> {
    return JSON.parse(
      fs.readFileSync(path.join(this.dataDir, TRUSTED_ARTISTS.file), 'utf8'),
    );
  }
  async saveTrustedArtists(t: TrustedArtistsFile): Promise<void> {
    writeJson(path.join(this.dataDir, TRUSTED_ARTISTS.file), t);
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    const p = path.join(this.dataDir, FILL_HISTORY.file);
    const history = readJson<unknown[]>(p, []);
    history.push(entry);
    writeJson(p, history);
  }
  async saveProgress(p: ProgressFile): Promise<void> {
    writeJson(path.join(this.dataDir, PROGRESS), p);
  }
}

/**
 * FillStorage backed by DurableCache (file-then-Redis fallback, mirrored writes),
 * plus the two capabilities unique to the fill flow: mirroring every save to the
 * browser client via `emit` for localStorage, and fillHistory's append semantics.
 * `saveProgress` stays local-only, unmirrored — it's a resumability checkpoint,
 * not one of the datasets that needs to survive an ephemeral filesystem.
 */
export class RedisAndClientStorage implements FillStorage {
  private cache: DurableCache;
  private progressPath: string;

  constructor(
    public readonly dataDir: string,
    userId: string,
    private emit?: (key: string, value: unknown) => void,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.cache = createDurableCache({ userId, dataDir });
    this.progressPath = path.join(dataDir, PROGRESS);
  }

  async loadBatchCache(): Promise<BatchCache> {
    return (await this.cache.load(BATCH_CACHE)) ?? {};
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    await this.cache.save(BATCH_CACHE, c);
    this.emit?.('batchCache', c);
  }
  async loadTrustedArtists(): Promise<TrustedArtistsFile> {
    const t = await this.cache.load(TRUSTED_ARTISTS);
    if (!t) {
      throw new Error(
        'trusted-artists.json not found and no Redis copy available',
      );
    }
    return t;
  }
  async saveTrustedArtists(t: TrustedArtistsFile): Promise<void> {
    await this.cache.save(TRUSTED_ARTISTS, t);
    this.emit?.('trustedArtists', t);
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    const history = ((await this.cache.load(FILL_HISTORY)) ??
      []) as FillHistoryEntry[];
    history.push(entry);
    await this.cache.save(FILL_HISTORY, history);
    this.emit?.('fillHistory', history);
  }
  saveProgress(p: ProgressFile): Promise<void> {
    writeJson(this.progressPath, p);
    return Promise.resolve();
  }
}
