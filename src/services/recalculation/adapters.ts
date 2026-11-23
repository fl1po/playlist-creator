import { playlistReads } from '../../lib/playlist-reads/index.js';
import type { UserSession } from '../../lib/user-session.js';
import {
  deezerPopularitySource,
  spotifyPlaylistWrites,
} from '../promotion-sync/adapters.js';
import type { ReleaseReads } from '../week-collection/index.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import { spotifyWeeklyPlaylistStore } from '../weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../weekly-playlists/index.js';
import type { RecalculationPorts } from './index.js';

/**
 * The production port set for the session's user. Their user data holds
 * what the unprocessed listing reuses between runs. A fill passes its own
 * `reads` so promotion sync shares the release reads its weeks remembered.
 */
export function spotifyRecalculationPorts(
  session: UserSession,
  opts: { reads?: ReleaseReads } = {},
): RecalculationPorts {
  const { userId } = session;
  const playlists = playlistReads(session);
  return {
    playlists,
    unprocessed: {
      find(allWeeklyId, log) {
        return unprocessedWeeklyPlaylists(
          { store: spotifyWeeklyPlaylistStore(session), playlists, userId },
          allWeeklyId,
          log,
        );
      },
    },
    sync: {
      reads: opts.reads ?? spotifyReleaseReads(session.gateway),
      playlists,
      popularity: deezerPopularitySource(() =>
        session.gateway.signal?.throwIfAborted(),
      ),
      writes: spotifyPlaylistWrites(session.gateway),
    },
  };
}
