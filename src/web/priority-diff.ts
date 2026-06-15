import fs from 'node:fs';
import path from 'node:path';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyClient, TrustedArtistsFile } from '../lib/types.js';
import {
  getNonListenedPlaylists,
  invalidateNonListenedCache,
} from '../services/non-listened-playlists.js';
import {
  deezerPopularitySource,
  promotionReads,
  spotifyPlaylistWrites,
} from '../services/promotion-sync/adapters.js';
import {
  type PriorityChange,
  type SyncDecision,
  syncPriorityChanges,
} from '../services/promotion-sync/index.js';

/** Render the loggable decisions; counts go through the sync events instead. */
function describeDecision(d: SyncDecision): string | null {
  switch (d.kind) {
    case 'demotion-removed':
      return `  ${d.playlist}: removed ${d.trackCount} track(s) from ${d.artists.join(', ')}`;
    case 'low-popularity':
      return `  low-popularity: ${d.artist} — ${d.release} (${d.popularity})`;
    case 'variant-stripped':
      return `  stripped ${d.reason}: ${d.artist} — ${d.release}`;
    default:
      return null;
  }
}

/** Run promotion sync if any P1/P2 boundary crossings occurred. */
export async function syncIfNeeded(
  changes: PriorityChange[],
  client: SpotifyClient,
  dataDir: string,
  allWeeklyId: string,
  minPopularity: number,
  pacer: RequestPacer,
  broadcast: (type: string, data: unknown) => void,
  trustedArtists?: TrustedArtistsFile,
): Promise<void> {
  const isP1P2 = (p: number | null) => p === 1 || p === 2;
  const hasBoundaryCrossing = changes.some(
    (c) => isP1P2(c.from) !== isP1P2(c.to),
  );
  if (!hasBoundaryCrossing) return;

  await client.recreateApi();

  const ctx = createSpotifyContext(
    client,
    {
      onRateLimitWait: (s) => {
        const display = s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s}s`;
        broadcast('log', {
          level: 'info',
          message: `  Rate limited, waiting ${display}...`,
        });
      },
      onNetworkRetry: (a, m) =>
        broadcast('log', {
          level: 'info',
          message: `  Network error, retry ${a}/${m}`,
        }),
      onError: (desc, err) => {
        if (err.message?.includes('404')) return;
        broadcast('log', {
          level: 'info',
          message: `  Error (${desc}): ${err.message}`,
        });
      },
    },
    pacer,
  );

  // Caller-side discovery: which weekly playlists are unprocessed + the AW
  // track set. Kept out of the module so its dataDir cache stays out of the seam.
  const meResult = await ctx.call(
    () => ctx.api.currentUser.profile(),
    'get user profile',
  );
  if (!meResult.success) throw new Error('Failed to get user profile');

  const { playlists, awTrackIds } = await getNonListenedPlaylists(
    ctx,
    meResult.data.id,
    allWeeklyId,
    dataDir,
    (msg) => broadcast('log', msg),
  );
  if (playlists.length === 0) {
    broadcast('log', 'No unprocessed weekly playlists found');
    return;
  }

  // Authoritative (post-recalc) roster when given; otherwise the persisted file.
  const trusted: TrustedArtistsFile =
    trustedArtists ??
    JSON.parse(
      fs.readFileSync(path.join(dataDir, 'trusted-artists.json'), 'utf8'),
    );

  const result = await syncPriorityChanges(
    changes,
    {
      unprocessedPlaylists: playlists,
      awTrackIds,
      trustedArtists: trusted,
      // Newly-promoted artists backfill their whole recent back-catalogue, so
      // hold them to a higher bar than the weekly gate — twice the configured
      // minimum — to keep stale low-popularity releases out.
      minPopularity: minPopularity * 2,
    },
    {
      reads: promotionReads(ctx),
      popularity: deezerPopularitySource(() => {
        void ctx.api; // throws if aborted
      }),
      writes: spotifyPlaylistWrites(ctx),
    },
    (e) => {
      if (e.phase === 'start') {
        broadcast('sync:start', {
          demoted: e.demoted,
          promoted: e.promoted,
          playlists: e.playlists,
        });
      } else {
        broadcast('sync:playlistSync', {
          name: e.playlist,
          removed: e.removed,
          added: e.added,
        });
      }
    },
  );

  for (const d of result.decisions) {
    const line = describeDecision(d);
    if (line) broadcast('log', line);
  }

  if (result.removed > 0 || result.added > 0) {
    invalidateNonListenedCache(dataDir);
  }
  broadcast('sync:complete', {
    totalRemoved: result.removed,
    totalAdded: result.added,
    playlistsSynced: result.playlistsSynced,
  });
  broadcast(
    'log',
    `Sync complete: ${result.removed} removed, ${result.added} added across ${result.playlistsSynced} playlist(s)`,
  );
}
