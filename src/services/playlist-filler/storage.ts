import type { BatchCache } from '../../lib/types.js';
import type { UserData } from '../../lib/user-data/index.js';
import { BATCH_CACHE, FILL_HISTORY } from '../../lib/user-data/index.js';

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

/**
 * The fill's own persistence: week progress (batch cache) and fill history.
 * The roster and recalculation state belong to the Recalculation module.
 */
export interface FillStorage {
  loadBatchCache(): Promise<BatchCache>;
  saveBatchCache(c: BatchCache): Promise<void>;
  appendFillHistory(entry: FillHistoryEntry): Promise<void>;
}

/** FillStorage over the user's data. */
export class DurableFillStorage implements FillStorage {
  constructor(private data: UserData) {}

  async loadBatchCache(): Promise<BatchCache> {
    return (await this.data.load(BATCH_CACHE)) ?? {};
  }
  async saveBatchCache(c: BatchCache): Promise<void> {
    await this.data.save(BATCH_CACHE, c);
  }
  async appendFillHistory(entry: FillHistoryEntry): Promise<void> {
    const history = ((await this.data.load(FILL_HISTORY)) ??
      []) as FillHistoryEntry[];
    history.push(entry);
    await this.data.save(FILL_HISTORY, history);
  }
}
