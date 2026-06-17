import fs from 'node:fs';
import path from 'node:path';
import { parseDate } from '../domain/tracks.js';
import { LISTENING_TIME_CACHE } from '../lib/cache-files.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../lib/pagination.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { SimplePlaylist } from '../lib/types.js';
import {
  redisDeleteCache,
  redisLoadCache,
  redisSaveCache,
} from '../web/redis-config-store.js';

const NON_LISTENED_CACHE = 'non-listened-cache.json';
const NON_LISTENED_REDIS = 'nonListened';

interface NonListenedCache {
  playlists: SimplePlaylist[];
}

/**
 * Invalidate the non-listened playlists and listening time caches — both the
 * local files and the durable Redis copies (fire-and-forget so callers can stay
 * synchronous). Pass `userId` to also clear Redis.
 */
export function invalidateNonListenedCache(
  dataDir: string,
  userId?: string,
): void {
  for (const file of [NON_LISTENED_CACHE, LISTENING_TIME_CACHE]) {
    try {
      fs.unlinkSync(path.join(dataDir, file));
    } catch {
      /* missing file is fine */
    }
  }
  if (userId) {
    void redisDeleteCache(userId, NON_LISTENED_REDIS);
    void redisDeleteCache(userId, 'listeningTime');
  }
}

/**
 * Get non-listened weekly playlists.
 *
 * Returns cached result when available. Otherwise iterates weekly playlists
 * from newest to oldest, stopping at the first with AW overlap. Result is
 * cached to disk so subsequent calls are instant.
 */
export async function getNonListenedPlaylists(
  ctx: SpotifyContext,
  userId: string,
  allWeeklyId: string,
  dataDir: string,
  log?: (message: string, level?: 'info' | 'debug') => void,
): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }> {
  const emit = log ?? (() => {});
  const cachePath = path.join(dataDir, NON_LISTENED_CACHE);

  const awTrackIds = new Set(await getAllPlaylistTracks(ctx, allWeeklyId));
  emit(`Loaded ${awTrackIds.size} tracks from All Weekly`);

  // Cache: prefer the local file, fall back to the durable Redis copy so a
  // fresh/ephemeral container reuses the scan instead of re-paginating.
  let cached: NonListenedCache | null = null;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    cached = await redisLoadCache<NonListenedCache>(
      userId,
      NON_LISTENED_REDIS,
    ).catch(() => null);
  }
  if (cached?.playlists != null) {
    emit(`Using cached non-listened playlists (${cached.playlists.length})`);
    return { playlists: cached.playlists, awTrackIds };
  }

  const allPlaylists = await getAllUserPlaylists(ctx, userId);
  emit(`Found ${allPlaylists.length} user playlists`);

  const weeklyPattern = /^(\d{2})\.(\d{2})\.(\d{2})$/;
  const weeklies = allPlaylists
    .filter((pl) => pl.trackCount > 0 && weeklyPattern.test(pl.name))
    .sort((a, b) => parseDate(b.name).getTime() - parseDate(a.name).getTime());

  emit(`Found ${weeklies.length} weekly playlists, scanning from newest...`);

  const nonListened: SimplePlaylist[] = [];

  for (let i = 0; i < weeklies.length; i++) {
    const pl = weeklies[i];
    const trackIds = await getAllPlaylistTracks(ctx, pl.id);
    const hasOverlap = trackIds.some((id) => awTrackIds.has(id));

    if (hasOverlap) {
      // Per-playlist scan progress is debug-level (hidden unless toggled on).
      emit(`  ${pl.name} — AW overlap found, cutoff reached`, 'debug');
      break;
    }

    emit(`  ${pl.name} — non-listened (${i + 1})`, 'debug');
    nonListened.push(pl);
  }

  nonListened.reverse();
  emit(`Result: ${nonListened.length} non-listened playlists`);

  const cache: NonListenedCache = { playlists: nonListened };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    /* fs is optional (ephemeral container) — Redis is the durable copy */
  }
  await redisSaveCache(userId, NON_LISTENED_REDIS, cache).catch(() => {});

  return { playlists: nonListened, awTrackIds };
}
