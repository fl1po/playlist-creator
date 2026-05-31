import path from 'node:path';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyClient } from '../lib/types.js';
import {
  type PlaylistSyncEventMap,
  PlaylistSyncerService,
  type PriorityChange,
} from '../services/playlist-syncer.js';
import { broadcastEvents } from './broadcast.js';

/** Run playlist sync if any P1/P2 boundary crossings occurred. */
export async function syncIfNeeded(
  changes: PriorityChange[],
  client: SpotifyClient,
  dataDir: string,
  allWeeklyId: string,
  pacer: RequestPacer,
  broadcast: (type: string, data: unknown) => void,
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

  const syncer = new PlaylistSyncerService(
    ctx,
    {
      allWeeklyId,
      trustedArtistsPath: path.join(dataDir, 'trusted-artists.json'),
      dataDir,
    },
    broadcastEvents<PlaylistSyncEventMap>(broadcast, {
      start: {
        type: 'sync:start',
        pack: (demoted, promoted, playlists) => ({
          demoted,
          promoted,
          playlists,
        }),
      },
      playlistSync: {
        type: 'sync:playlistSync',
        pack: (name, removed, added) => ({ name, removed, added }),
      },
      complete: {
        type: 'sync:complete',
        pack: (totalRemoved, totalAdded, playlistsSynced) => ({
          totalRemoved,
          totalAdded,
          playlistsSynced,
        }),
      },
      log: { log: (msg) => msg },
    }),
  );

  await syncer.run(changes);
}
