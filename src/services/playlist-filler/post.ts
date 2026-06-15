import type { PriorityChange } from '../promotion-sync/index.js';
import type { FillResult, PrioritySnapshot } from './fill-run.js';
import type { FillHistoryEntry, FillStorage, ProgressFile } from './storage.js';

/** Diff before/after priorities into a flat change list. */
export function computePriorityChanges(
  before: PrioritySnapshot,
  after: PrioritySnapshot,
): PriorityChange[] {
  const changes: PriorityChange[] = [];
  for (const [name, from] of before) {
    const to = after.get(name) ?? null;
    if (from !== to) changes.push({ artist: name, from, to });
  }
  for (const [name, to] of after) {
    if (!before.has(name)) changes.push({ artist: name, from: null, to });
  }
  return changes;
}

/** Write the per-run progress file (mirrors what runWebFill used to do). */
export async function writeProgressFile(
  storage: FillStorage,
  result: FillResult,
): Promise<void> {
  const completed = result.results.filter((r) => !(r.error || r.skipped));
  const progress: ProgressFile = {
    completed: completed.length,
    total: result.results.length,
    lastProcessed: result.results[result.results.length - 1]?.date,
    results: result.results,
  };
  await storage.saveProgress(progress);
}

/** Append a fill-history entry if any tracks were added. */
export async function maybeAppendFillHistory(
  storage: FillStorage,
  result: FillResult,
): Promise<void> {
  const completed = result.results.filter((r) => !(r.error || r.skipped));
  const totalTracks = completed.reduce((s, r) => s + (r.tracksAdded || 0), 0);
  if (totalTracks === 0) return;

  const releasesByPriority: Record<string, number> = {};
  for (const r of completed) {
    for (const rel of r.releases ?? []) {
      const key =
        rel.priority === 'editorial' ? 'editorial' : `p${rel.priority}`;
      releasesByPriority[key] = (releasesByPriority[key] || 0) + 1;
    }
  }
  const entry: FillHistoryEntry = {
    timestamp: new Date().toISOString(),
    datesProcessed: completed.length,
    datesTotal: result.results.length,
    totalTracks,
    totalAlbums: completed.reduce((s, r) => s + (r.albumsCount || 0), 0),
    totalSingles: completed.reduce((s, r) => s + (r.singlesCount || 0), 0),
    totalSkipped: completed.reduce((s, r) => s + (r.skippedCount || 0), 0),
    releasesByPriority,
  };
  await storage.appendFillHistory(entry);
}
