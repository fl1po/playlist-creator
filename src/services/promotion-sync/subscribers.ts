import type {
  PromotionProgressEvent,
  PromotionSyncResult,
  SyncDecision,
} from './index.js';

/**
 * Render the loggable decisions; counts go through the sync events instead.
 * Removed/added artists are shown inline per playlist (playlist-synced), so
 * only the skip diagnostics (low-popularity / variant-stripped) are logged
 * here to avoid duplicating the demotion-removed detail.
 */
function describeDecision(d: SyncDecision): string | null {
  switch (d.kind) {
    case 'low-popularity':
      return `  low-popularity: ${d.artist} — ${d.release} (${d.popularity})`;
    case 'variant-stripped':
      return `  stripped ${d.reason}: ${d.artist} — ${d.release}`;
    default:
      return null;
  }
}

/** Sync's caller-facing progress + logging port — mirrors playlist-filler's EventHandlers pattern. */
export interface SyncHandlers {
  onProgress(e: PromotionProgressEvent): void;
  onLog(message: string, level?: 'info' | 'debug' | 'warn'): void;
  onComplete(result: PromotionSyncResult): void;
}

// ── Console subscriber (CLI) ────────────────────────────────────────────────

export function consoleSyncHandlers(): SyncHandlers {
  return {
    onProgress: (e) => {
      if (e.phase === 'start') {
        console.log(
          `Syncing priority changes: ${e.demoted} demoted, ${e.promoted} promoted, across ${e.playlists} playlist(s)`,
        );
      } else {
        console.log(
          `  ${e.playlist}: -${e.removed}/+${e.added}${e.removedArtists?.length ? ` (removed: ${e.removedArtists.join(', ')})` : ''}${e.addedArtists?.length ? ` (added: ${e.addedArtists.join(', ')})` : ''}`,
        );
      }
    },
    onLog: (message) => console.log(message),
    onComplete: (result) => {
      for (const d of result.decisions) {
        const line = describeDecision(d);
        if (line) console.log(line);
      }
      console.log(
        `Sync complete: ${result.removed} removed, ${result.added} added across ${result.playlistsSynced} playlist(s)`,
      );
    },
  };
}

// ── Broadcast subscriber (web) ──────────────────────────────────────────────

export function broadcastSyncHandlers(
  broadcast: (type: string, data: unknown) => void,
): SyncHandlers {
  return {
    onProgress: (e) => {
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
          removedArtists: e.removedArtists,
          addedArtists: e.addedArtists,
        });
      }
    },
    onLog: (message, level) =>
      broadcast('log', { level: level ?? 'info', message }),
    onComplete: (result) => {
      for (const d of result.decisions) {
        const line = describeDecision(d);
        if (line) broadcast('log', line);
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
    },
  };
}
