import type { ArtistData } from "../lib/types.js";

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

export interface ArtistScanInput {
  allWeekly: { trackCount: number; latestPosition: number } | null;
  bestOfAllWeekly: { trackCount: number; latestPosition: number } | null;
  awTotal: number;
  boawTotal: number;
  spotifyId: string | null;
}

export function computeArtistData(
  input: ArtistScanInput,
  weights?: ScoringWeights,
  thresholds?: PriorityThresholds,
): ArtistData {
  const allWeeklyCount = input.allWeekly?.trackCount ?? 0;
  const bestOfAllWeeklyCount = input.bestOfAllWeekly?.trackCount ?? 0;
  const latestPositionAW = input.allWeekly?.latestPosition ?? 0;
  const latestPositionBoAW = input.bestOfAllWeekly?.latestPosition ?? 0;

  const recencyBonusAW = input.allWeekly
    ? calculateRecencyBonusAW(latestPositionAW, input.awTotal)
    : 0;
  const recencyBonusBoAW = input.bestOfAllWeekly
    ? calculateRecencyBonusBoAW(latestPositionBoAW, input.boawTotal)
    : 0;

  const score = calculateScore(
    allWeeklyCount,
    bestOfAllWeeklyCount,
    recencyBonusAW,
    recencyBonusBoAW,
    weights,
  );

  return {
    allWeekly: allWeeklyCount,
    bestOfAllWeekly: bestOfAllWeeklyCount,
    latestPositionAW,
    latestPositionBoAW,
    recencyBonusAW,
    recencyBonusBoAW,
    score,
    priority: determinePriority(score, thresholds),
    spotifyId: input.spotifyId,
  };
}
