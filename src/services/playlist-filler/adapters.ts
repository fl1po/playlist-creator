import { anthropicKeyFromEnv } from '../../lib/anthropic-key.js';
import type { BatchCache } from '../../lib/types.js';
import type { UserSession } from '../../lib/user-session.js';
import { claudeTasteJudge } from '../ai-finds/claude-taste-judge.js';
import { deezerCandidateSource } from '../ai-finds/deezer-candidate-source.js';
import { promotionReads } from '../promotion-sync/adapters.js';
import { spotifyRecalculationPorts } from '../recalculation/adapters.js';
import { deezerPopularitySource } from '../week-collection/adapters.js';
import type { CheckpointStore } from '../week-collection/index.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import type { FillPorts } from './fill-run.js';
import { DurableFillStorage, type FillStorage } from './storage.js';

/**
 * Production CheckpointStore: week progress lives in
 * `BatchCache.artistSearchProgress`, persisted through FillStorage. The batch cache is read once, on first use, and this holds
 * the live copy so its other fields survive every save.
 */
export function batchCacheCheckpoints(storage: FillStorage): CheckpointStore {
  let cache: BatchCache | null = null;
  const live = async (): Promise<BatchCache> => {
    if (!cache) cache = await storage.loadBatchCache();
    return cache;
  };
  return {
    async load(week) {
      const p = (await live()).artistSearchProgress;
      if (!p || p.date !== week) return null;
      return {
        week: p.date,
        artistsSearched: p.artistsSearched,
        foundReleases: p.foundReleases,
      };
    },
    async save(progress) {
      const c = await live();
      c.artistSearchProgress = {
        date: progress.week,
        artistsSearched: progress.artistsSearched,
        foundReleases: progress.foundReleases,
      };
      await storage.saveBatchCache(c);
    },
    async clear() {
      const c = await live();
      c.artistSearchProgress = undefined;
      await storage.saveBatchCache(c);
    },
  };
}

/**
 * The production port set for one user's fill. The user data holds that
 * user's week progress, unprocessed-playlists listing and the Deezer artist
 * lookups AI finds reuse. AI finds' ports exist only when `env` has an
 * Anthropic key.
 */
export function fillPorts(
  session: UserSession,
  env: NodeJS.ProcessEnv = process.env,
): FillPorts {
  const { gateway, data } = session;
  const checkAbort = () => gateway.signal?.throwIfAborted();
  const apiKey = anthropicKeyFromEnv(env);
  return {
    week: {
      reads: spotifyReleaseReads(gateway),
      popularity: deezerPopularitySource(checkAbort),
      checkpoints: batchCacheCheckpoints(new DurableFillStorage(data)),
    },
    weekly: spotifyWeeklyPlaylistStore(gateway),
    history: promotionReads(gateway),
    recalculation: spotifyRecalculationPorts(gateway, session),
    ai:
      apiKey === undefined
        ? undefined
        : ({ weeks }) => ({
            candidates: deezerCandidateSource({ data, checkAbort }),
            judge: claudeTasteJudge({
              apiKey,
              fillWeeks: weeks,
              signal: gateway.signal,
            }),
          }),
  };
}
