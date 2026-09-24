import { computeArtistData } from '../../domain/artists.js';
import type {
  ArtistData,
  PlaylistArtistData,
  PlaylistScanResult,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { type UserConfig, secondarySourceName } from '../../lib/user-config.js';

function sourceScan(d: PlaylistArtistData | undefined) {
  return d
    ? {
        primaryCount: d.primaryCount,
        featuredCount: d.featuredCount,
        latestPosition: d.latestPosition,
        featuredAtLatest: d.featuredAtLatest,
      }
    : null;
}

/**
 * Score every artist found in the two source scans into the trusted artists
 * roster, under the user's weights, thresholds and featured multiplier.
 */
export function scoreRoster(
  aw: PlaylistScanResult,
  boaw: PlaylistScanResult,
  userConfig: UserConfig,
  today = new Date().toISOString().split('T')[0],
): TrustedArtistsFile {
  const { scoring, sourcePlaylists } = userConfig;
  const t = scoring.priorityThresholds;

  const artistCounts: Record<string, ArtistData> = {};
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const allArtists = new Set([
    ...aw.artistData.keys(),
    ...boaw.artistData.keys(),
  ]);

  for (const name of allArtists) {
    const a = aw.artistData.get(name);
    const b = boaw.artistData.get(name);
    const data = computeArtistData(
      {
        allWeekly: sourceScan(a),
        bestOfAllWeekly: sourceScan(b),
        awTotal: aw.totalTracks,
        boawTotal: boaw.totalTracks,
        spotifyId: a?.id ?? b?.id ?? null,
      },
      scoring,
      t,
      scoring.featuredMultiplier,
    );
    artistCounts[name] = data;
    if (data.priority !== null && data.priority in counts)
      counts[data.priority as keyof typeof counts]++;
  }

  const boawName = secondarySourceName(userConfig);
  return {
    metadata: {
      source: `Dynamic priority calculation from All Weekly + ${boawName}`,
      lastFullAnalysis: today,
      playlists: {
        allWeekly: {
          id: sourcePlaylists.allWeeklyId,
          trackCount: aw.totalTracks,
          lastFetched: today,
        },
        bestOfAllWeekly: {
          id: sourcePlaylists.bestOfAllWeeklyId,
          trackCount: boaw.totalTracks,
          lastFetched: today,
        },
      },
      scoringFormula: `Score = (allWeekly * ${scoring.awWeight}) + (bestOfAllWeekly * ${scoring.boawWeight}) + recencyBonusAW + recencyBonusBoAW; featured appearances count as ${scoring.featuredMultiplier}x`,
      priorityThresholds: {
        '1': `>= ${t.p1}`,
        '2': `${t.p2}-${t.p1 - 1}`,
        '3': `${t.p3}-${t.p2 - 1}`,
        '4': `${t.p4}-${t.p3 - 1}`,
      },
      // Descriptive only — mirrors calculateRecencyBonusAW/BoAW in
      // domain/artists.ts; keep the two in sync.
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
      stats: {
        totalUniqueArtists: allArtists.size,
        p1Count: counts[1],
        p2Count: counts[2],
        p3Count: counts[3],
        p4Count: counts[4],
      },
    },
    artistCounts,
  };
}
