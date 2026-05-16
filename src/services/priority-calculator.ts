import {
  type PriorityThresholds,
  type ScoringWeights,
  computeArtistData,
} from '../domain/artists.js';
import { getLikedTracksWithPositions, getPlaylistTracksWithPositions } from '../lib/pagination.js';
import { type EventHandlers, ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { ArtistData, TrustedArtistsFile } from '../lib/types.js';
import { secondarySourceName } from '../lib/user-config.js';

// ── Events ──────────────────────────────────────────────────────────────────

export type PriorityCalculatorEventMap = {
  scanStart: [playlistName: string];
  scanProgress: [playlistName: string, offset: number, total: number];
  scanComplete: [playlistName: string, artistCount: number, trackCount: number];
  calculationComplete: [stats: PriorityStats];
  topArtists: [artists: Array<[string, ArtistData]>];
  saved: [path: string];
};

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
  useLikedSongs?: boolean;
  scoringWeights?: ScoringWeights;
  priorityThresholds?: PriorityThresholds;
}

const DEFAULTS = {
  allWeeklyId: '',
  bestOfAllWeeklyId: '',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PriorityCalculatorService {
  private ctx: SpotifyContext;
  private emitter: ServiceEmitter<PriorityCalculatorEventMap>;
  private opts: Required<PriorityCalculatorOptions>;

  constructor(
    ctx: SpotifyContext,
    options?: PriorityCalculatorOptions,
    events?: EventHandlers<PriorityCalculatorEventMap>,
  ) {
    this.ctx = ctx;
    this.emitter = new ServiceEmitter(events);
    this.opts = {
      allWeeklyId: options?.allWeeklyId ?? DEFAULTS.allWeeklyId,
      bestOfAllWeeklyId:
        options?.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
      useLikedSongs: options?.useLikedSongs ?? false,
      scoringWeights: options?.scoringWeights,
      priorityThresholds: options?.priorityThresholds,
    } as Required<PriorityCalculatorOptions>;
  }

  async run(): Promise<TrustedArtistsFile> {
    const progressFor = (name: string) => (fetched: number, total: number) =>
      this.emitter.emit('scanProgress', name, fetched, total);

    this.emitter.emit('scanStart', 'All Weekly');
    const { artistData: awData, totalTracks: awTotal } =
      await getPlaylistTracksWithPositions(this.ctx, this.opts.allWeeklyId, progressFor('All Weekly'));
    this.emitter.emit('scanComplete', 'All Weekly', awData.size, awTotal);

    const boawSourceName = secondarySourceName({ sourcePlaylists: { useLikedSongs: this.opts.useLikedSongs } });
    this.emitter.emit('scanStart', boawSourceName);
    const { artistData: boawData, totalTracks: boawTotal } = this.opts.useLikedSongs
      ? await getLikedTracksWithPositions(this.ctx, progressFor(boawSourceName))
      : await getPlaylistTracksWithPositions(this.ctx, this.opts.bestOfAllWeeklyId, progressFor(boawSourceName));
    this.emitter.emit('scanComplete', boawSourceName, boawData.size, boawTotal);

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
          allWeekly: aw
            ? {
                trackCount: aw.trackCount,
                latestPosition: Math.max(...aw.positions),
              }
            : null,
          bestOfAllWeekly: boaw
            ? {
                trackCount: boaw.trackCount,
                latestPosition: Math.max(...boaw.positions),
              }
            : null,
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
    this.emitter.emit('calculationComplete', stats);

    // Top artists
    const sorted = Object.entries(artistCounts).sort(
      (a, b) => b[1].score - a[1].score,
    );
    this.emitter.emit('topArtists', sorted.slice(0, 30));

    // Build output
    const today = new Date().toISOString().split('T')[0];
    const output: TrustedArtistsFile = {
      metadata: {
        source: `Dynamic priority calculation from All Weekly + ${boawSourceName}`,
        lastFullAnalysis: today,
        playlists: {
          allWeekly: {
            id: this.opts.allWeeklyId,
            trackCount: awTotal,
            lastFetched: today,
          },
          bestOfAllWeekly: {
            id: this.opts.bestOfAllWeeklyId,
            trackCount: boawTotal,
            lastFetched: today,
          },
        },
        scoringFormula: `Score = (allWeekly * ${this.opts.scoringWeights?.awWeight ?? 2}) + (bestOfAllWeekly * ${this.opts.scoringWeights?.boawWeight ?? 3}) + recencyBonusAW + recencyBonusBoAW`,
        priorityThresholds: {
          '1': `>= ${this.opts.priorityThresholds?.p1 ?? 60}`,
          '2': `${this.opts.priorityThresholds?.p2 ?? 25}-${(this.opts.priorityThresholds?.p1 ?? 60) - 1}`,
          '3': `${this.opts.priorityThresholds?.p3 ?? 15}-${(this.opts.priorityThresholds?.p2 ?? 25) - 1}`,
          '4': `${this.opts.priorityThresholds?.p4 ?? 1}-${(this.opts.priorityThresholds?.p3 ?? 15) - 1}`,
        },
        recencyBonusRules: {
          note: 'Based on latest (most recent) track position. Higher % = more recent = higher bonus.',
          allWeekly: {
            '90-100%': 20,
            '70-90%': 15,
            '50-70%': 12,
            '20-50%': 10,
            '5-20%': 7,
            '0-5%': 5,
          },
          bestOfAllWeekly: {
            '90-100%': 15,
            '70-90%': 10,
            '40-70%': 5,
            '15-40%': 2,
            '0-15%': 1,
          },
        },
        stats,
      },
      artistCounts,
    };

    return output;
  }
}
