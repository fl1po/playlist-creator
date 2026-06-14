import type { ArtistData } from '../lib/types.js';

/**
 * Default share of credit a featured appearance (artists[1..n]) earns relative
 * to a primary appearance (artists[0]). 0.5 = featured artists gain half. Used
 * whenever a caller doesn't pass an explicit multiplier; overridable per user
 * via `scoring.featuredMultiplier` in user-config.
 */
export const DEFAULT_FEATURED_MULTIPLIER = 0.5;

// ── Recency bonuses ─────────────────────────────────────────────────────────

export function calculateRecencyBonusAW(
  latestPosition: number,
  totalTracks: number,
): number {
  const percentage = latestPosition / totalTracks;
  if (percentage >= 0.9) return 20;
  if (percentage >= 0.7) return 15;
  if (percentage >= 0.5) return 12;
  if (percentage >= 0.2) return 10;
  if (percentage >= 0.05) return 7;
  return 5;
}

export function calculateRecencyBonusBoAW(
  latestPosition: number,
  totalTracks: number,
): number {
  const percentage = latestPosition / totalTracks;
  if (percentage >= 0.9) return 15;
  if (percentage >= 0.7) return 10;
  if (percentage >= 0.4) return 5;
  if (percentage >= 0.15) return 2;
  return 1;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface ScoringWeights {
  awWeight: number;
  boawWeight: number;
}

export interface PriorityThresholds {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
}

export function calculateScore(
  allWeeklyCount: number,
  bestOfAllWeeklyCount: number,
  recencyBonusAW: number,
  recencyBonusBoAW: number,
  weights?: ScoringWeights,
): number {
  const aw = weights?.awWeight ?? 2;
  const boaw = weights?.boawWeight ?? 3;
  return (
    allWeeklyCount * aw +
    bestOfAllWeeklyCount * boaw +
    recencyBonusAW +
    recencyBonusBoAW
  );
}

export function determinePriority(
  score: number,
  thresholds?: PriorityThresholds,
): number | null {
  const t = thresholds ?? { p1: 60, p2: 25, p3: 15, p4: 1 };
  if (score >= t.p1) return 1;
  if (score >= t.p2) return 2;
  if (score >= t.p3) return 3;
  if (score >= t.p4) return 4;
  return null;
}

// ── Filtering ───────────────────────────────────────────────────────────────

export function filterByPriority(
  artists: Record<string, ArtistData>,
  priorities: number[],
): Array<[string, ArtistData]> {
  const prioSet = new Set(priorities);
  return Object.entries(artists)
    .filter(([_, data]) => data.priority !== null && prioSet.has(data.priority))
    .sort((a, b) => b[1].score - a[1].score);
}

// ── Full artist score calculation ───────────────────────────────────────────

/** Per-source scan data with the primary/featured role split preserved. */
export interface ArtistSourceScan {
  primaryCount: number;
  featuredCount: number;
  latestPosition: number;
  featuredAtLatest: boolean;
}

export interface ArtistScanInput {
  allWeekly: ArtistSourceScan | null;
  bestOfAllWeekly: ArtistSourceScan | null;
  awTotal: number;
  boawTotal: number;
  spotifyId: string | null;
}

/**
 * Apply the featured-gain multiplier to one source: featured appearances count
 * for `m` instead of 1, and the recency bonus is scaled by `m` when the most
 * recent appearance was a feature.
 */
function effectiveSource(
  src: ArtistSourceScan,
  total: number,
  recencyFn: (latestPosition: number, totalTracks: number) => number,
  m: number,
): { effectiveCount: number; recencyBonus: number } {
  return {
    effectiveCount: src.primaryCount + m * src.featuredCount,
    recencyBonus:
      recencyFn(src.latestPosition, total) * (src.featuredAtLatest ? m : 1),
  };
}

export function computeArtistData(
  input: ArtistScanInput,
  weights?: ScoringWeights,
  thresholds?: PriorityThresholds,
  featuredMultiplier?: number,
): ArtistData {
  const m = featuredMultiplier ?? DEFAULT_FEATURED_MULTIPLIER;

  // Raw appearance counts (integers) are kept for display; the score uses the
  // multiplier-adjusted effective counts and recency.
  const allWeeklyCount = input.allWeekly
    ? input.allWeekly.primaryCount + input.allWeekly.featuredCount
    : 0;
  const bestOfAllWeeklyCount = input.bestOfAllWeekly
    ? input.bestOfAllWeekly.primaryCount + input.bestOfAllWeekly.featuredCount
    : 0;
  const latestPositionAW = input.allWeekly?.latestPosition ?? 0;
  const latestPositionBoAW = input.bestOfAllWeekly?.latestPosition ?? 0;

  const aw = input.allWeekly
    ? effectiveSource(
        input.allWeekly,
        input.awTotal,
        calculateRecencyBonusAW,
        m,
      )
    : { effectiveCount: 0, recencyBonus: 0 };
  const boaw = input.bestOfAllWeekly
    ? effectiveSource(
        input.bestOfAllWeekly,
        input.boawTotal,
        calculateRecencyBonusBoAW,
        m,
      )
    : { effectiveCount: 0, recencyBonus: 0 };

  const score = calculateScore(
    aw.effectiveCount,
    boaw.effectiveCount,
    aw.recencyBonus,
    boaw.recencyBonus,
    weights,
  );

  return {
    allWeekly: allWeeklyCount,
    bestOfAllWeekly: bestOfAllWeeklyCount,
    latestPositionAW,
    latestPositionBoAW,
    recencyBonusAW: aw.recencyBonus,
    recencyBonusBoAW: boaw.recencyBonus,
    score,
    priority: determinePriority(score, thresholds),
    spotifyId: input.spotifyId,
  };
}
