import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { createApiCall } from "../lib/api-wrapper.js";
import { getPlaylistTracksWithPositions } from "../lib/pagination.js";
import type { ArtistData, SpotifyClient, TrustedArtistsFile } from "../lib/types.js";
import {
  computeArtistData,
  type ScoringWeights,
  type PriorityThresholds,
} from "../domain/artists.js";

// ── Events ──────────────────────────────────────────────────────────────────

export interface PriorityCalculatorEvents {
  onScanStart?: (playlistName: string) => void;
  onScanProgress?: (playlistName: string, offset: number, total: number) => void;
  onScanComplete?: (playlistName: string, artistCount: number, trackCount: number) => void;
  onCalculationComplete?: (stats: PriorityStats) => void;
  onTopArtists?: (artists: Array<[string, ArtistData]>) => void;
  onSaved?: (path: string) => void;
}

export interface PriorityStats {
  totalUniqueArtists: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  p4Count: number;
}

export interface PriorityCalculatorOptions {
  allWeeklyId?: string;
  bestOfAllWeeklyId?: string;
  scoringWeights?: ScoringWeights;
  priorityThresholds?: PriorityThresholds;
}

const DEFAULTS = {
  allWeeklyId: "",
  bestOfAllWeeklyId: "",
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PriorityCalculatorService {
  private client: SpotifyClient;
  private events: PriorityCalculatorEvents;
  private opts: Required<PriorityCalculatorOptions>;
  private apiCall: ReturnType<typeof createApiCall>;

  constructor(
    client: SpotifyClient,
    options?: PriorityCalculatorOptions,
    events?: PriorityCalculatorEvents,
  ) {
    this.client = client;
    this.events = events ?? {};
    this.opts = {
      allWeeklyId: options?.allWeeklyId ?? DEFAULTS.allWeeklyId,
      bestOfAllWeeklyId: options?.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
      scoringWeights: options?.scoringWeights,
      priorityThresholds: options?.priorityThresholds,
    } as Required<PriorityCalculatorOptions>;
    this.apiCall = createApiCall(client);
  }

  get api(): SpotifyApi {
    return this.client.api;
  }

  async run(): Promise<TrustedArtistsFile> {
    // Scan both playlists
    this.events.onScanStart?.("All Weekly");
    const { artistData: awData, totalTracks: awTotal } =
      await getPlaylistTracksWithPositions(this.api, this.opts.allWeeklyId, this.apiCall);
    this.events.onScanComplete?.("All Weekly", awData.size, awTotal);

    this.events.onScanStart?.("Best of All Weekly");
    const { artistData: boawData, totalTracks: boawTotal } =
      await getPlaylistTracksWithPositions(this.api, this.opts.bestOfAllWeeklyId, this.apiCall);
    this.events.onScanComplete?.("Best of All Weekly", boawData.size, boawTotal);

    // Combine all unique artists
    const allArtists = new Set([...awData.keys(), ...boawData.keys()]);

    // Calculate scores
    const artistCounts: Record<string, ArtistData> = {};
    const priorityCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

    for (const artistName of allArtists) {
      const aw = awData.get(artistName);
      const boaw = boawData.get(artistName);

      const data = computeArtistData(
        {
          allWeekly: aw ? { trackCount: aw.trackCount, latestPosition: Math.max(...aw.positions) } : null,
          bestOfAllWeekly: boaw ? { trackCount: boaw.trackCount, latestPosition: Math.max(...boaw.positions) } : null,
          awTotal,
          boawTotal,
          spotifyId: aw?.id ?? boaw?.id ?? null,
        },
        this.opts.scoringWeights,
        this.opts.priorityThresholds,
      );

      artistCounts[artistName] = data;

      if (data.priority !== null && data.priority in priorityCounts) {
        priorityCounts[data.priority as keyof typeof priorityCounts]++;
      }
    }

    const stats: PriorityStats = {
      totalUniqueArtists: allArtists.size,
      p1Count: priorityCounts[1],
      p2Count: priorityCounts[2],
      p3Count: priorityCounts[3],
      p4Count: priorityCounts[4],
    };
    this.events.onCalculationComplete?.(stats);

    // Top artists
    const sorted = Object.entries(artistCounts).sort((a, b) => b[1].score - a[1].score);
    this.events.onTopArtists?.(sorted.slice(0, 30));

    // Build output
    const today = new Date().toISOString().split("T")[0];
    const output: TrustedArtistsFile = {
      metadata: {
        source: "Dynamic priority calculation from All Weekly + Best of All Weekly",
        lastFullAnalysis: today,
        playlists: {
          allWeekly: { id: this.opts.allWeeklyId, trackCount: awTotal, lastFetched: today },
          bestOfAllWeekly: { id: this.opts.bestOfAllWeeklyId, trackCount: boawTotal, lastFetched: today },
        },
        scoringFormula: `Score = (allWeekly * ${this.opts.scoringWeights?.awWeight ?? 2}) + (bestOfAllWeekly * ${this.opts.scoringWeights?.boawWeight ?? 3}) + recencyBonusAW + recencyBonusBoAW`,
        priorityThresholds: {
          "1": `>= ${this.opts.priorityThresholds?.p1 ?? 60}`,
          "2": `${this.opts.priorityThresholds?.p2 ?? 25}-${(this.opts.priorityThresholds?.p1 ?? 60) - 1}`,
          "3": `${this.opts.priorityThresholds?.p3 ?? 15}-${(this.opts.priorityThresholds?.p2 ?? 25) - 1}`,
          "4": `${this.opts.priorityThresholds?.p4 ?? 1}-${(this.opts.priorityThresholds?.p3 ?? 15) - 1}`,
        },
        recencyBonusRules: {
          note: "Based on latest (most recent) track position. Higher % = more recent = higher bonus.",
          allWeekly: { "90-100%": 20, "70-90%": 15, "50-70%": 12, "20-50%": 10, "5-20%": 7, "0-5%": 5 },
          bestOfAllWeekly: { "90-100%": 15, "70-90%": 10, "40-70%": 5, "15-40%": 2, "0-15%": 1 },
        },
        stats,
      },
      artistCounts,
    };

    return output;
  }
}
