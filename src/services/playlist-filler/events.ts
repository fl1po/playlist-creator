import type { DateResult } from '../../lib/types.js';
import type { PriorityChange } from '../promotion-sync/index.js';
import type { SyncProgress } from '../recalculation/index.js';
import type {
  CollectionDecision,
  WeekProgressEvent,
} from '../week-collection/index.js';
import type { WeeklyWrite } from '../weekly-playlists/index.js';

/**
 * What a fill reports as it runs: its own steps plus the week collection's,
 * the weekly-playlist writes' and the trailing sync's events, each kept in
 * its owner's shape. `describeFill` words them (ADR-0007).
 */
export type FillEvent =
  /** The fill's own narration, worded where it happens. */
  | { kind: 'log'; message: string; level?: 'info' | 'warn' }
  /** Saved week progress exists; `artists` were already searched. */
  | { kind: 'resumed'; date: string; artists: string[] }
  | { kind: 'start'; dates: string[] }
  | { kind: 'date-start'; date: string; index: number; total: number }
  | { kind: 'week'; event: WeekProgressEvent }
  | { kind: 'decision'; decision: CollectionDecision }
  | { kind: 'written'; write: WeeklyWrite }
  | { kind: 'recalculating' }
  /** Tier moves from one mid-fill recalculation, already sorted. */
  | { kind: 'recalculated'; changes: PriorityChange[] }
  | { kind: 'date-complete'; result: DateResult }
  | { kind: 'date-error'; date: string; error: Error }
  | { kind: 'complete'; results: DateResult[]; durationMinutes: number }
  /** The trailing promotion sync. */
  | { kind: 'sync'; event: SyncProgress };

export interface ExternalPlaylistSource {
  userId: string;
  namePattern: string;
  dateFormat: string;
  label: string;
}

export interface EditorialFilterConfig {
  minPopularity: number;
  minFollowers: number;
}
