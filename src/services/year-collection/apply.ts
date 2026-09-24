/**
 * Turn a reviewed plan into monthly playlists.
 *
 * Reads nothing but the plan — every track id was captured during collection,
 * so applying costs only the writes. That is the whole point of the two-phase
 * split: fetching is measured in hours, applying in minutes.
 *
 * Playlists are named `YYYY.MM`, deliberately *not* the `DD.MM.YY` weekly
 * convention. `non-listened-playlists.ts` and `fill-run.ts` both treat any
 * `DD.MM.YY`-shaped name as a weekly playlist, and `parseDate` maps a
 * two-digit year below 50 to 20xx — so a playlist called `01.01.16` would be picked up as a weekly
 * and make fill try to generate every Friday since 2016.
 */

import { getAllUserPlaylists } from '../../lib/pagination.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import { type YearPlan, months, orderedForMonth } from './plan.js';

/** Spotify's cap per add-items request. */
const ADD_BATCH = 100;

/** Spotify's hard ceiling on playlist size. */
const PLAYLIST_LIMIT = 10_000;

export interface ApplyEvents {
  onPlaylistCreated?: (name: string, id: string) => void;
  onPlaylistReused?: (name: string, id: string) => void;
  onTracksAdded?: (name: string, added: number, total: number) => void;
  onWarning?: (message: string) => void;
  checkAbort?: () => void;
}

export interface ApplyResult {
  playlists: Array<{
    name: string;
    id: string;
    url: string;
    releases: number;
    tracks: number;
  }>;
}

export async function applyPlan(
  ctx: SpotifyContext,
  userId: string,
  plan: YearPlan,
  events?: ApplyEvents,
): Promise<ApplyResult> {
  const existing = await getAllUserPlaylists(ctx, userId);
  const byName = new Map(existing.map((p) => [p.name, p]));
  const result: ApplyResult = { playlists: [] };

  for (const month of months(plan)) {
    events?.checkAbort?.();

    const releases = orderedForMonth(plan, month);
    const trackIds = releases.flatMap((r) => r.trackIds);
    if (trackIds.length === 0) continue;

    if (trackIds.length > PLAYLIST_LIMIT) {
      events?.onWarning?.(
        `${month} has ${trackIds.length} tracks, above Spotify's ${PLAYLIST_LIMIT} limit — ` +
          `the last ${trackIds.length - PLAYLIST_LIMIT} will not be added`,
      );
    }

    let playlistId: string;
    let playlistUrl: string;

    // A reused playlist is appended to, not reconciled: re-applying a plan
    // over playlists it already filled duplicates every track.
    const found = byName.get(month);
    if (found) {
      playlistId = found.id;
      playlistUrl = `https://open.spotify.com/playlist/${found.id}`;
      events?.onPlaylistReused?.(month, playlistId);
    } else {
      const created = await ctx.call(
        () =>
          ctx.api.playlists.createPlaylist(userId, {
            name: month,
            description: `${plan.year} retrospective — releases from ${month}`,
            public: false,
          }),
        `create playlist ${month}`,
      );
      if (!created.success) {
        throw created.error ?? new Error(`Failed to create playlist ${month}`);
      }
      playlistId = created.data.id;
      playlistUrl = created.data.external_urls.spotify;
      events?.onPlaylistCreated?.(month, playlistId);
    }

    const toAdd = trackIds.slice(0, PLAYLIST_LIMIT);
    for (let i = 0; i < toAdd.length; i += ADD_BATCH) {
      events?.checkAbort?.();
      const batch = toAdd.slice(i, i + ADD_BATCH);
      const added = await ctx.call(
        () =>
          ctx.api.playlists.addItemsToPlaylist(
            playlistId,
            batch.map((id) => `spotify:track:${id}`),
          ),
        `add tracks to ${month}`,
      );
      if (!added.success) {
        throw added.error ?? new Error(`Failed to add tracks to ${month}`);
      }
      events?.onTracksAdded?.(
        month,
        Math.min(i + ADD_BATCH, toAdd.length),
        toAdd.length,
      );
    }

    result.playlists.push({
      name: month,
      id: playlistId,
      url: playlistUrl,
      releases: releases.length,
      tracks: toAdd.length,
    });
  }

  return result;
}
