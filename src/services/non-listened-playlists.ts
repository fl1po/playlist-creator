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

const NON_LISTENED_CACHE = 'non-listened-cache.json';

interface NonListenedCache {
  playlists: SimplePlaylist[];
}

/** Invalidate the non-listened playlists and listening time caches. */
export function invalidateNonListenedCache(dataDir: string): void {
  for (const file of [NON_LISTENED_CACHE, LISTENING_TIME_CACHE]) {
    try {
      fs.unlinkSync(path.join(dataDir, file));
    } catch {
      /* missing file is fine */
    }
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
  log?: (message: string) => void,
): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }> {
  const emit = log ?? (() => {});
  const cachePath = path.join(dataDir, NON_LISTENED_CACHE);

  const awTrackIds = new Set(await getAllPlaylistTracks(ctx, allWeeklyId));
  emit(`Loaded ${awTrackIds.size} tracks from All Weekly`);

  try {
    const cached: NonListenedCache = JSON.parse(
      fs.readFileSync(cachePath, 'utf8'),
    );
    if (cached.playlists != null) {
      emit(`Using cached non-listened playlists (${cached.playlists.length})`);
      return { playlists: cached.playlists, awTrackIds };
    }
  } catch {
    /* cache miss */
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
      emit(`  ${pl.name} — AW overlap found, cutoff reached`);
      break;
    }

    emit(`  ${pl.name} — non-listened (${i + 1})`);
    nonListened.push(pl);
  }

  nonListened.reverse();
  emit(`Result: ${nonListened.length} non-listened playlists`);

  const cache: NonListenedCache = { playlists: nonListened };
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  return { playlists: nonListened, awTrackIds };
}
