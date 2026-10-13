import { parseDate } from '../domain/tracks.js';
import { AI_PICKS } from '../lib/cache-files.js';
import type { DurableCache } from '../lib/durable-cache.js';
import {
  getAllUserPlaylists,
  getPlaylistTracksWithArtists,
} from '../lib/pagination.js';
import type { SpotifyGateway } from '../lib/spotify/gateway.js';
import type { AiPicksRecord } from './week-collection/index.js';

export type AiPick = Extract<AiPicksRecord, { picks: unknown }>['picks'][number];

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

/** Every week with an AI-picks record, newest first. Reads no Spotify. */
export async function listAiPicks(
  cache: DurableCache,
): Promise<Array<{ date: string; record: AiPicksRecord }>> {
  const records = (await cache.load(AI_PICKS)) ?? {};
  return Object.entries(records)
    .map(([date, record]) => ({ date, record }))
    .sort((a, b) => parseDate(b.date).getTime() - parseDate(a.date).getTime());
}

/** The date's picks; null when its record is a skip or there is none. */
export async function loadWeekAiPicks(
  cache: DurableCache,
  date: string,
): Promise<AiPick[] | null> {
  const record = (await cache.load(AI_PICKS))?.[date];
  return record && 'picks' in record ? record.picks : null;
}

/**
 * A week's picks as its weekly playlist holds them now: `exists: false` once
 * the playlist is gone. `present` keeps the picks with any track of their
 * album still in the playlist, highest confidence first; the rest were
 * pruned and count only towards `total`.
 */
export type WeekPicks =
  | { exists: false }
  | { exists: true; total: number; present: AiPick[] };

/** Read the date's weekly playlist live to see which picks are still in it. */
export async function readWeekPicks(
  gateway: SpotifyGateway,
  userId: string,
  date: string,
  picks: AiPick[],
): Promise<WeekPicks> {
  const playlists = await getAllUserPlaylists(gateway, userId);
  const playlist = playlists.find((p) => p.name === date);
  if (!playlist) return { exists: false };

  const tracks = await getPlaylistTracksWithArtists(gateway, playlist.id);
  const albums = new Set(tracks.map((t) => t.albumId));
  const present = picks
    .filter((p) => albums.has(p.albumId))
    .sort((a, b) => b.confidence - a.confidence);
  return { exists: true, total: picks.length, present };
}
