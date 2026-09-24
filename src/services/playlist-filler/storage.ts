import fs from 'node:fs';
import path from 'node:path';
import { BATCH_CACHE, FILL_HISTORY } from '../../lib/cache-files.js';
import type { DurableCache } from '../../lib/durable-cache.js';
import type { BatchCache } from '../../lib/types.js';

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

/**
 * The fill's own persistence: week progress (batch cache), fill history and
 * the per-run progress file. The roster and recalculation state belong to the
 * Recalculation module and live in its DurableCache.
 */
export interface FillStorage {
  loadBatchCache(): Promise<BatchCache>;
  saveBatchCache(c: BatchCache): Promise<void>;
  appendFillHistory(entry: FillHistoryEntry): Promise<void>;
  saveProgress(p: ProgressFile): Promise<void>;
}

const PROGRESS = 'batch-p1p2-progress.json';

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * FillStorage over a DurableCache — file-only for the CLI (`redis: null`), or
 * the web session's cache, whose saves are already mirrored to Redis and the
 * browser. `saveProgress` stays local-only: it's a per-run report, not one of
 * the datasets that needs to survive an ephemeral filesystem.
 */
export class DurableFillStorage implements FillStorage {
  private progressPath: string;

  constructor(
    private cache: DurableCache,
    dataDir: string,
  ) {
    this.progressPath = path.join(dataDir, PROGRESS);
  }

  async loadBatchCache(): Promise<BatchCache> {
    return (await this.cache.load(BATCH_CACHE)) ?? {};
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    await this.cache.save(BATCH_CACHE, c);
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    const history = ((await this.cache.load(FILL_HISTORY)) ??
      []) as FillHistoryEntry[];
    history.push(entry);
    await this.cache.save(FILL_HISTORY, history);
  }
  async saveProgress(p: ProgressFile): Promise<void> {
    writeJson(this.progressPath, p);
  }
}
