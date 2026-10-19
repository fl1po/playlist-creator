// ── Config ──────────────────────────────────────────────────────────────────

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface UserTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SpotifyConfig extends AppConfig {
  accessToken?: string;
  refreshToken?: string;
}

export interface ConfigStore {
  load(): SpotifyConfig;
  save(config: SpotifyConfig): void;
}

// ── Pagination ──────────────────────────────────────────────────────────────

export interface SimplePlaylist {
  id: string;
  name: string;
  trackCount: number;
  /** Spotify's version of the playlist; changes on any edit, by anyone. */
  snapshotId?: string;
}

export interface AlbumTrack {
  id: string;
  name: string;
  key: string;
  explicit?: boolean;
}

export interface PlaylistAlbumInfo {
  id: string;
  name: string;
  artistName: string;
  artistIds: string[];
  releaseDate: string;
  albumType: string;
  totalTracks: number;
}

// ── Domain types ────────────────────────────────────────────────────────────

export interface ArtistData {
  allWeekly: number;
  bestOfAllWeekly: number;
  latestPositionAW: number;
  latestPositionBoAW: number;
  recencyBonusAW: number;
  recencyBonusBoAW: number;
  score: number;
  priority: number | null;
  spotifyId: string | null;
}

export interface TrustedArtistsFile {
  metadata: {
    source: string;
    lastFullAnalysis: string;
    playlists: {
      allWeekly: { id: string; trackCount: number; lastFetched: string };
      bestOfAllWeekly: { id: string; trackCount: number; lastFetched: string };
    };
    scoringFormula: string;
    priorityThresholds: Record<string, string>;
    recencyBonusRules: {
      note: string;
      allWeekly: Record<string, number>;
      bestOfAllWeekly: Record<string, number>;
    };
    stats: {
      totalUniqueArtists: number;
      p1Count: number;
      p2Count: number;
      p3Count: number;
      p4Count: number;
    };
  };
  artistCounts: Record<string, ArtistData>;
}

export interface FoundRelease {
  id: string;
  name: string;
  type: string;
  release_date: string;
  artistName: string;
  artistSpotifyId: string;
  priority: number | 'editorial' | 'ai';
  score: number;
  markets?: number;
  /** Where a find came from when not the artist search: an editorial
   * playlist name, or `AI`. */
  source?: string;
  /** Set on AI finds: the LLM's confidence (0–100) and one-line reason. */
  aiFind?: { confidence: number; reason: string };
}

export interface DateResult {
  date: string;
  playlistId: string;
  playlistUrl: string;
  tracksAdded: number;
  albumsCount: number;
  singlesCount: number;
  skippedCount: number;
  releases: Array<FoundRelease & { tracksAdded: number }>;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export interface CachedScanResult {
  artistData: Record<string, PlaylistArtistData>;
  totalTracks: number;
}

/**
 * What recalculation remembers between runs: the source snapshots it last
 * scored against, and the scans it can reuse while a source is unchanged.
 */
export interface RecalculationState {
  allWeeklySnapshot?: string;
  bestOfAllWeeklySnapshot?: string;
  awScanCache?: CachedScanResult;
  boawScanCache?: CachedScanResult;
}

/**
 * The fill's week progress. Caches written before recalculation got its own
 * state still carry the `RecalculationState` fields; recalculation reads them
 * once as a migration and never writes them here again.
 */
export interface BatchCache extends Partial<RecalculationState> {
  artistSearchProgress?: {
    date: string;
    artistsSearched: number;
    foundReleases: Record<string, FoundRelease>;
  };
}

// ── Recency scanning ────────────────────────────────────────────────────────

/**
 * Per-artist scan data. Keeps each appearance's role — primary (artists[0]) vs
 * featured (artists[1..n]) — so a featured-gain multiplier can be applied at
 * scoring time. `latestPosition` is the highest (most recent) position seen and
 * `featuredAtLatest` records the role there (drives recency scaling).
 */
export interface PlaylistArtistData {
  primaryCount: number;
  featuredCount: number;
  latestPosition: number;
  featuredAtLatest: boolean;
  id: string | null;
}

export interface PlaylistScanResult {
  artistData: Map<string, PlaylistArtistData>;
  totalTracks: number;
}

/**
 * Whether a cached scan uses the current role-aware shape. Caches written
 * before the featured-multiplier change carry the legacy {positions,trackCount}
 * shape; reusing them would read `undefined` role fields and produce NaN scores,
 * so callers must treat a stale-shaped cache as a miss and re-scan.
 */
export function isRoleTaggedCache(cached: CachedScanResult): boolean {
  const first = Object.values(cached.artistData)[0];
  if (!first) return true; // empty cache is trivially compatible
  return (
    typeof first.primaryCount === 'number' &&
    typeof first.latestPosition === 'number'
  );
}

export function toScanResult(cached: CachedScanResult): PlaylistScanResult {
  return {
    artistData: new Map(Object.entries(cached.artistData)),
    totalTracks: cached.totalTracks,
  };
}

export function toCachedScanResult(scan: PlaylistScanResult): CachedScanResult {
  return {
    artistData: Object.fromEntries(scan.artistData),
    totalTracks: scan.totalTracks,
  };
}
