import crypto from 'node:crypto';
import { parseDate } from '../domain/tracks.js';
import { LISTENING_TIME, NON_LISTENED } from '../lib/cache-files.js';
import { createDurableCache } from '../lib/durable-cache.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../lib/pagination.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { SimplePlaylist } from '../lib/types.js';
import { isWeeklyPlaylistName } from './weekly-playlists/index.js';

interface NonListenedCache {
  playlists: SimplePlaylist[];
  /** All Weekly's contents when the listing was taken; see `fingerprint`. */
  awFingerprint?: string;
}

/**
 * Order-independent digest of All Weekly's track ids. Only the user writes to
 * All Weekly (listening a playlist adds its picks there), so a changed
 * fingerprint means the listing may now include a listened playlist.
 */
function fingerprint(awTrackIds: Set<string>): string {
  return crypto
    .createHash('sha1')
    .update([...awTrackIds].sort().join(','))
    .digest('hex');
}

/**
 * Invalidate the non-listened playlists and listening time caches — both the
 * local files and the durable Redis copies.
 */
export async function invalidateNonListenedCache(
  dataDir: string,
  userId: string,
): Promise<void> {
  const cache = createDurableCache({ userId, dataDir });
  await Promise.all([cache.delete(NON_LISTENED), cache.delete(LISTENING_TIME)]);
}

/**
 * Get non-listened weekly playlists, oldest first.
 *
 * Returns the cached listing while All Weekly is unchanged since it was taken.
 * Otherwise walks weekly playlists from newest to oldest, stopping at the
 * first with AW overlap — anything older is assumed listened. The listing goes
 * to the durable cache (disk + Redis) until All Weekly changes or
 * `invalidateNonListenedCache`; `awTrackIds` is always read fresh.
 */
export async function getNonListenedPlaylists(
  ctx: SpotifyContext,
  userId: string,
  allWeeklyId: string,
  dataDir: string,
  log?: (message: string, level?: 'info' | 'debug') => void,
): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }> {
  const emit = log ?? (() => {});
  const cache = createDurableCache({ userId, dataDir });

  const awTrackIds = new Set(await getAllPlaylistTracks(ctx, allWeeklyId));
  emit(`Loaded ${awTrackIds.size} tracks from All Weekly`);
  const awFingerprint = fingerprint(awTrackIds);

  const cached = (await cache.load(NON_LISTENED)) as NonListenedCache | null;
  if (cached?.playlists != null && cached.awFingerprint === awFingerprint) {
    emit(`Using cached non-listened playlists (${cached.playlists.length})`);
    return { playlists: cached.playlists, awTrackIds };
  }
  if (cached?.playlists != null)
    emit('All Weekly changed since the last scan — rescanning');

  const allPlaylists = await getAllUserPlaylists(ctx, userId);
  emit(`Found ${allPlaylists.length} user playlists`);

  const weeklies = allPlaylists
    .filter((pl) => pl.trackCount > 0 && isWeeklyPlaylistName(pl.name))
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

  await cache.save(NON_LISTENED, { playlists: nonListened, awFingerprint });

  return { playlists: nonListened, awTrackIds };
}
