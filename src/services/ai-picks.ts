import { AI_PICKS } from '../lib/cache-files.js';
import type { DurableCache } from '../lib/durable-cache.js';
import type { AiPicksRecord } from './week-collection/index.js';

/**
 * Keep a week's AI-picks record, keyed by its weekly playlist's date. Any
 * earlier record for that date is replaced; records never expire.
 */
export async function saveAiPicks(
  cache: DurableCache,
  date: string,
  record: AiPicksRecord,
): Promise<void> {
  const records = (await cache.load(AI_PICKS)) ?? {};
  await cache.save(AI_PICKS, { ...records, [date]: record });
}

/** Drop a week's AI-picks record, if it has one. */
export async function forgetAiPicks(
  cache: DurableCache,
  date: string,
): Promise<void> {
  const records = await cache.load(AI_PICKS);
  if (!(records && date in records)) return;
  const { [date]: _, ...rest } = records;
  await cache.save(AI_PICKS, rest);
}
