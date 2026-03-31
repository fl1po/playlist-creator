import type { SpotifyApi } from "@spotify/web-api-ts-sdk";

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

// ── Config store ────────────────────────────────────────────────────────────

export interface ConfigStore {
  load(): SpotifyConfig;
  save(config: SpotifyConfig): void;
}

// ── API wrapper ─────────────────────────────────────────────────────────────

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; authError?: boolean; error?: Error };

export interface ApiCallOptions {
  onRateLimitWait?: (seconds: number) => void;
  onNetworkRetry?: (attempt: number, maxAttempts: number) => void;
  onLongSleep?: (hours: number, wakeTime: Date) => void;
  onLongSleepWake?: () => void;
  onError?: (description: string, error: Error) => void;
  onSuccess?: () => void;
  /** Checked before every API call and retry. Throw to abort. */
  onBeforeCall?: () => void;
}

// ── Spotify client ──────────────────────────────────────────────────────────

export interface SpotifyClient {
  api: SpotifyApi;
  refreshToken(): Promise<string>;
  recreateApi(): Promise<SpotifyApi>;
  runAuth(attempt?: number): Promise<boolean>;
}

// ── Pagination ──────────────────────────────────────────────────────────────

export interface PlaylistTrackItem {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string };
}

export interface SimplePlaylist {
  id: string;
  name: string;
  trackCount: number;
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
  priority: number | "editorial";
  score: number;
  markets?: number;
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

export interface BatchCache {
  allWeeklySnapshot?: string;
  bestOfAllWeeklySnapshot?: string;
  artistSearchProgress?: {
    date: string;
    artistsSearched: number;
    foundReleases: Record<string, FoundRelease>;
  };
}

// ── Recency scanning ────────────────────────────────────────────────────────

export interface PlaylistArtistData {
  positions: number[];
  trackCount: number;
  id: string | null;
}

export interface PlaylistScanResult {
  artistData: Map<string, PlaylistArtistData>;
  totalTracks: number;
}
