import {
  type PriorityThresholds,
  type ScoringWeights,
  computeArtistData,
} from '../domain/artists.js';
import type { PlaylistArtistData, PlaylistScanResult } from '../lib/types.js';

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ScoredArtist {
  score: number;
  priority: number | null;
}

/**
 * Score one artist at a given featured-gain `multiplier`, delegating to the
 * production `computeArtistData` so the simulation and the real algorithm share
 * one implementation. multiplier = 1 reproduces full-credit scoring.
 */
export function scoreArtist(
  aw: PlaylistArtistData | undefined,
  boaw: PlaylistArtistData | undefined,
  awTotal: number,
  boawTotal: number,
  multiplier: number,
  weights?: ScoringWeights,
  thresholds?: PriorityThresholds,
): ScoredArtist {
  const data = computeArtistData(
    {
      allWeekly: aw ?? null,
      bestOfAllWeekly: boaw ?? null,
      awTotal,
      boawTotal,
      spotifyId: null,
    },
    weights,
    thresholds,
    multiplier,
  );
  return { score: data.score, priority: data.priority };
}

// ── Diff + summary ────────────────────────────────────────────────────────────

export interface TierCounts {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  none: number;
}

export interface TierChange {
  name: string;
  baseScore: number;
  newScore: number;
  baseTier: number | null;
  newTier: number | null;
  direction: 'demotion' | 'promotion';
  /** Change touches tier P1 or P2 — the boundary the playlist-syncer acts on. */
  p1p2Crossing: boolean;
}

export interface SimulationSummary {
  multiplier: number;
  totalArtists: number;
  baseTierCounts: TierCounts;
  newTierCounts: TierCounts;
  affected: number;
  demotions: number;
  promotions: number;
  p1p2Crossings: number;
}

export interface SimulationResult {
  summary: SimulationSummary;
  changes: TierChange[];
}

/** Lower rank = higher priority; null (untiered) is the worst. */
function tierRank(t: number | null): number {
  return t === null ? 5 : t;
}

function emptyCounts(): TierCounts {
  return { p1: 0, p2: 0, p3: 0, p4: 0, none: 0 };
}

function bump(c: TierCounts, t: number | null): void {
  if (t === 1) c.p1++;
  else if (t === 2) c.p2++;
  else if (t === 3) c.p3++;
  else if (t === 4) c.p4++;
  else c.none++;
}

/**
 * Score every artist from the same scan data twice — at 1.0x (baseline) and at
 * `multiplier` (treatment) — and report tier changes. The baseline coming from
 * the same scan isolates the multiplier as the only variable.
 */
export function simulate(
  awScan: PlaylistScanResult,
  boawScan: PlaylistScanResult,
  multiplier: number,
  weights?: ScoringWeights,
  thresholds?: PriorityThresholds,
): SimulationResult {
  const names = new Set([
    ...awScan.artistData.keys(),
    ...boawScan.artistData.keys(),
  ]);

  const baseTierCounts = emptyCounts();
  const newTierCounts = emptyCounts();
  const changes: TierChange[] = [];
  let demotions = 0;
  let promotions = 0;
  let p1p2Crossings = 0;

  for (const name of names) {
    const aw = awScan.artistData.get(name);
    const boaw = boawScan.artistData.get(name);
    const base = scoreArtist(
      aw,
      boaw,
      awScan.totalTracks,
      boawScan.totalTracks,
      1,
      weights,
      thresholds,
    );
    const treat = scoreArtist(
      aw,
      boaw,
      awScan.totalTracks,
      boawScan.totalTracks,
      multiplier,
      weights,
      thresholds,
    );

    bump(baseTierCounts, base.priority);
    bump(newTierCounts, treat.priority);

    if (base.priority !== treat.priority) {
      const direction =
        tierRank(treat.priority) > tierRank(base.priority)
          ? 'demotion'
          : 'promotion';
      const p1p2Crossing = [base.priority, treat.priority].some(
        (t) => t === 1 || t === 2,
      );
      if (direction === 'demotion') demotions++;
      else promotions++;
      if (p1p2Crossing) p1p2Crossings++;
      changes.push({
        name,
        baseScore: base.score,
        newScore: treat.score,
        baseTier: base.priority,
        newTier: treat.priority,
        direction,
        p1p2Crossing,
      });
    }
  }

  // Highest baseline score first; tie-break by largest score drop.
  changes.sort((a, b) => {
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    return b.baseScore - b.newScore - (a.baseScore - a.newScore);
  });

  return {
    summary: {
      multiplier,
      totalArtists: names.size,
      baseTierCounts,
      newTierCounts,
      affected: changes.length,
      demotions,
      promotions,
      p1p2Crossings,
    },
    changes,
  };
}

// ── Report rendering ──────────────────────────────────────────────────────────

export interface ReportContext {
  secondaryName: string;
  awTotal: number;
  boawTotal: number;
  /** Optional one-liner comparing the 1.0x baseline to stored trusted-artists. */
  driftNote?: string;
  generatedAt: string;
}

function tier(t: number | null): string {
  return t === null ? '—' : `P${t}`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function countsLine(c: TierCounts): string {
  return `P1 ${c.p1} · P2 ${c.p2} · P3 ${c.p3} · P4 ${c.p4} · untiered ${c.none}`;
}

export function renderReport(
  result: SimulationResult,
  ctx: ReportContext,
): string {
  const { summary: s, changes } = result;
  const m = s.multiplier;
  const lines: string[] = [];

  lines.push(`# Featured-artist gain simulation — ${m}x`);
  lines.push('');
  lines.push(
    `_Generated ${ctx.generatedAt}. Read-only: no production data written._`,
  );
  lines.push('');
  lines.push(
    `Featured appearances (artists[1..n]) count as **${m}** instead of 1.0; ` +
      `recency is multiplied by **${m}** when the most-recent appearance was a feature.`,
  );
  lines.push('');
  lines.push('## Scan');
  lines.push('');
  lines.push(`- All Weekly: ${ctx.awTotal} tracks`);
  lines.push(`- ${ctx.secondaryName}: ${ctx.boawTotal} tracks`);
  lines.push(`- Unique artists scored: ${s.totalArtists}`);
  if (ctx.driftNote) lines.push(`- ${ctx.driftNote}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Baseline (1.0x): ${countsLine(s.baseTierCounts)}`);
  lines.push(`- Simulated (${m}x): ${countsLine(s.newTierCounts)}`);
  lines.push(
    `- Artists changing tier: **${s.affected}** (${s.demotions} demotions, ${s.promotions} promotions)`,
  );
  lines.push(
    `- Changes touching P1/P2 (playlist-syncer would act): **${s.p1p2Crossings}**`,
  );
  lines.push('');
  lines.push('## Tier changes');
  lines.push('');
  if (changes.length === 0) {
    lines.push('_No artist changes tier at this multiplier._');
  } else {
    lines.push('| Artist | Score | Tier | P1/P2 |');
    lines.push('|---|---|---|---|');
    for (const c of changes) {
      const flag = c.p1p2Crossing ? '⚠️' : '';
      lines.push(
        `| ${c.name} | ${round(c.baseScore)} → ${round(c.newScore)} | ${tier(c.baseTier)} → ${tier(c.newTier)} | ${flag} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
