import { filterByPriority } from '../../domain/artists.js';
import { filterLowPopularity, filterVariants } from '../../domain/releases.js';
import { getValidDates, parseDate } from '../../domain/tracks.js';
import type { PlaylistTrackWithArtists } from '../../lib/pagination.js';
import type {
  ArtistData,
  FoundRelease,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../../lib/types.js';
import {
  type Run,
  collectTracks,
  getArtistWindowReleases,
} from '../week-collection/engine.js';
import type {
  CollectionDecision,
  PopularitySource,
  ReleaseReads,
  VariantStripReason,
} from '../week-collection/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** One artist crossing the P1/P2 boundary during recalculation. */
export interface PriorityChange {
  artist: string;
  from: number | null;
  to: number | null;
}

// ── Ports (the seam) ─────────────────────────────────────────────────────────

/**
 * The reads a promotion sync needs: every release read (shared with week
 * collection via the engine) plus the two playlist-track reads the removal and
 * addition phases use. Prod adapter wraps SpotifyContext + pagination; test
 * adapter is an in-memory fixture catalog.
 */
export interface PromotionReads extends ReleaseReads {
  /** Playlist tracks with their artist names + album id (removal phase). */
  playlistTracksWithArtists(
    playlistId: string,
  ): Promise<PlaylistTrackWithArtists[]>;
  /** Playlist track ids, to exclude what's already present (addition phase). */
  playlistTrackIds(playlistId: string): Promise<string[]>;
}

/**
 * Playlist mutation. The adapter owns Spotify's 100-item chunking and the
 * `spotify:track:` uri formatting; the module just hands over track ids.
 */
export interface PlaylistWrites {
  addTracks(playlistId: string, trackIds: string[]): Promise<void>;
  removeTracks(playlistId: string, trackIds: string[]): Promise<void>;
}

export interface PromotionSyncPorts {
  reads: PromotionReads;
  popularity: PopularitySource;
  writes: PlaylistWrites;
}

// ── Decisions + progress ─────────────────────────────────────────────────────

/**
 * The audit trail, returned as data. Addition reuses the week-collection
 * `CollectionDecision` kinds (release-found, variant, deluxe, …); removal adds
 * its own two.
 */
export type SyncDecision =
  | CollectionDecision
  | {
      kind: 'demotion-removed';
      playlist: string;
      artists: string[];
      trackCount: number;
    }
  | { kind: 'demotion-kept'; playlist: string; trackCount: number };

/** Liveness only — never carries decisions. */
export type PromotionProgressEvent =
  | { phase: 'start'; demoted: number; promoted: number; playlists: number }
  | {
      phase: 'playlist-synced';
      playlist: string;
      removed: number;
      added: number;
    };

// ── Input / result ───────────────────────────────────────────────────────────

export interface PromotionSyncInput {
  /** Non-listened weekly playlists to reconcile (caller-discovered). */
  unprocessedPlaylists: SimplePlaylist[];
  /** All Weekly track ids — excluded from every addition. */
  awTrackIds: Set<string>;
  /** Authoritative (post-recalc) roster: the new P1/P2 set drives both phases. */
  trustedArtists: TrustedArtistsFile;
  /** Release popularity floor — already the lenient backfill bar. */
  minPopularity: number;
}

export interface PromotionSyncResult {
  removed: number;
  added: number;
  playlistsSynced: number;
  perPlaylist: Array<{ playlist: string; removed: number; added: number }>;
  decisions: SyncDecision[];
}

// ── Implementation ───────────────────────────────────────────────────────────

const isP1P2 = (p: number | null) => p === 1 || p === 2;

/**
 * Reconcile already-published weekly playlists with a recalculation's priority
 * changes: remove the tracks of artists demoted out of P1/P2, and backfill
 * in-window releases from artists promoted into P1/P2.
 *
 * Shares the release-discovery + track-collection engine with `collectWeek`,
 * but has no editorial merge, no checkpoints, and matches each playlist's own
 * date rather than one Friday window. Removal treats an album as a unit: it
 * stays whole if any track belongs to a P1/P2 artist. Returns all decisions —
 * removal included — as data.
 */
export async function syncPriorityChanges(
  changes: PriorityChange[],
  input: PromotionSyncInput,
  ports: PromotionSyncPorts,
  onProgress?: (e: PromotionProgressEvent) => void,
): Promise<PromotionSyncResult> {
  const { reads, popularity, writes } = ports;
  const { unprocessedPlaylists, awTrackIds, trustedArtists, minPopularity } =
    input;

  const decisions: SyncDecision[] = [];
  const counts = new Map<string, { removed: number; added: number }>();
  const bump = (name: string, kind: 'removed' | 'added', n: number) => {
    const c = counts.get(name) ?? { removed: 0, added: 0 };
    c[kind] += n;
    counts.set(name, c);
  };
  const result = (): PromotionSyncResult => ({
    removed: [...counts.values()].reduce((s, c) => s + c.removed, 0),
    added: [...counts.values()].reduce((s, c) => s + c.added, 0),
    playlistsSynced: counts.size,
    perPlaylist: [...counts].map(([playlist, c]) => ({ playlist, ...c })),
    decisions,
  });

  const demoted = changes.filter((c) => isP1P2(c.from) && !isP1P2(c.to));
  const promoted = changes.filter((c) => !isP1P2(c.from) && isP1P2(c.to));
  if (demoted.length === 0 && promoted.length === 0) return result();

  onProgress?.({
    phase: 'start',
    demoted: demoted.length,
    promoted: promoted.length,
    playlists: unprocessedPlaylists.length,
  });

  const p1p2Set = new Set(
    filterByPriority(trustedArtists.artistCounts, [1, 2]).map(([name]) => name),
  );

  // ── Removal phase ──────────────────────────────────────────────────────────
  // An album is a unit: the whole album stays if any track has a P1/P2 artist
  // (it was added for that feature); otherwise the demoted artist's album group
  // is removed entirely.
  if (demoted.length > 0) {
    const demotedNames = new Set(demoted.map((d) => d.artist.toLowerCase()));

    for (const pl of unprocessedPlaylists) {
      const tracks = await reads.playlistTracksWithArtists(pl.id);
      const albumGroups = new Map<string, PlaylistTrackWithArtists[]>();
      for (const t of tracks) {
        const key = t.albumId || t.id;
        const group = albumGroups.get(key);
        if (group) group.push(t);
        else albumGroups.set(key, [t]);
      }

      const removeIds: string[] = [];
      const removedArtists = new Set<string>();

      for (const [, group] of albumGroups) {
        const groupDemoted = group.some((t) =>
          t.artistNames.some((n) => demotedNames.has(n.toLowerCase())),
        );
        if (!groupDemoted) continue;
        const groupP1P2 = group.some((t) =>
          t.artistNames.some((n) => p1p2Set.has(n)),
        );
        if (groupP1P2) {
          decisions.push({
            kind: 'demotion-kept',
            playlist: pl.name,
            trackCount: group.length,
          });
          continue;
        }
        for (const t of group) {
          removeIds.push(t.id);
          for (const n of t.artistNames) {
            if (demotedNames.has(n.toLowerCase())) removedArtists.add(n);
          }
        }
      }

      if (removeIds.length > 0) {
        await writes.removeTracks(pl.id, removeIds);
        bump(pl.name, 'removed', removeIds.length);
        decisions.push({
          kind: 'demotion-removed',
          playlist: pl.name,
          artists: [...removedArtists],
          trackCount: removeIds.length,
        });
        onProgress?.({
          phase: 'playlist-synced',
          playlist: pl.name,
          removed: removeIds.length,
          added: 0,
        });
      }
    }
  }

  // ── Addition phase ─────────────────────────────────────────────────────────
  if (promoted.length > 0) {
    // One run for the whole sync: an artist's album list is fetched once and
    // memoized across every playlist. The engine emits CollectionDecisions; we
    // fold them into the wider SyncDecision trail once the phase completes.
    const additionDecisions: CollectionDecision[] = [];
    const run: Run = {
      reads,
      decisions: additionDecisions,
      albumsByArtist: new Map(),
    };

    const resolved: Array<{ name: string; id: string; data: ArtistData }> = [];
    for (const change of promoted) {
      const data = trustedArtists.artistCounts[change.artist];
      if (!data) continue;
      // Anchor to the stored Spotify id so a common name doesn't resolve to an
      // unrelated artist; fall back to a name search only when none was stored.
      const id =
        data.spotifyId ?? (await reads.searchArtist(change.artist))?.id;
      if (!id) continue;
      resolved.push({ name: change.artist, id, data });
    }

    for (const pl of unprocessedPlaylists) {
      if (resolved.length === 0) break;
      const validDates = getValidDates(parseDate(pl.name));
      const foundReleases = new Map<string, FoundRelease>();

      for (const { name, id, data } of resolved) {
        const releases = await getArtistWindowReleases(run, id, validDates);
        for (const r of releases) {
          if (foundReleases.has(r.id)) continue;
          foundReleases.set(r.id, {
            id: r.id,
            name: r.name,
            type: r.type,
            release_date: r.release_date,
            markets: r.markets,
            artistName: name,
            artistSpotifyId: id,
            priority: data.priority ?? 0,
            score: data.score,
          });
          additionDecisions.push({
            kind: 'release-found',
            artist: name,
            release: r.name,
            type: r.type,
          });
        }
      }

      if (foundReleases.size === 0) continue;

      const pops = await popularity.lookup(foundReleases);
      const lowPop = filterLowPopularity(foundReleases, pops, minPopularity);
      for (const rid of lowPop) {
        const r = foundReleases.get(rid);
        if (r) {
          additionDecisions.push({
            kind: 'low-popularity',
            artist: r.artistName,
            release: r.name,
            popularity: pops.get(rid) ?? 0,
          });
        }
        foundReleases.delete(rid);
      }

      const { filtered, removed } = filterVariants(foundReleases);
      for (const { type, release } of removed) {
        additionDecisions.push({
          kind: 'variant-stripped',
          reason: type as VariantStripReason,
          artist: release.artistName,
          release: release.name,
        });
      }
      for (const rid of filtered) foundReleases.delete(rid);
      if (foundReleases.size === 0) continue;

      const existing = new Set(await reads.playlistTrackIds(pl.id));
      const exclude = new Set<string>([...awTrackIds, ...existing]);
      const { collected } = await collectTracks(run, foundReleases, exclude);
      const trackIds = collected.flatMap((c) => c.trackIds);

      if (trackIds.length > 0) {
        await writes.addTracks(pl.id, trackIds);
        bump(pl.name, 'added', trackIds.length);
        onProgress?.({
          phase: 'playlist-synced',
          playlist: pl.name,
          removed: 0,
          added: trackIds.length,
        });
      }
    }

    decisions.push(...additionDecisions);
  }

  return result();
}
