import fs from 'node:fs';
import path from 'node:path';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyClient, TrustedArtistsFile } from '../lib/types.js';
import {
  PlaylistSyncerService,
  type PlaylistSyncEventMap,
  type PriorityChange,
} from '../services/playlist-syncer.js';
import { broadcastEvents } from './broadcast.js';

/** Take a snapshot of artist priorities from trusted-artists.json. */
export function snapshotPriorities(
  trustedPath: string,
): Map<string, number | null> {
  const priorities = new Map<string, number | null>();
  try {
    const prev = JSON.parse(
      fs.readFileSync(trustedPath, 'utf-8'),
    ) as TrustedArtistsFile;
    for (const [name, data] of Object.entries(prev.artistCounts))
      priorities.set(name, data.priority);
  } catch {
    /* first run or missing file */
  }
  return priorities;
}

/** Compare old priority snapshot with current trusted-artists file. */
export function diffPriorities(
  old: Map<string, number | null>,
  current: TrustedArtistsFile,
): PriorityChange[] {
  const changes: PriorityChange[] = [];
  for (const [name, data] of Object.entries(current.artistCounts)) {
    const prev = old.get(name) ?? null;
    if (prev !== data.priority)
      changes.push({ artist: name, from: prev, to: data.priority });
  }
  for (const [name, prev] of old) {
    if (!(name in current.artistCounts))
      changes.push({ artist: name, from: prev, to: null });
  }
  return changes;
}

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
