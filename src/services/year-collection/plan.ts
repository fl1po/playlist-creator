/**
 * The plan file — the pipeline's single durable artifact.
 *
 * It serves two jobs, which is why fetching and applying are split:
 *
 * - **Review.** Every kept release with its scores, cluster and signals, plus
 *   every rejected one with the reason, so the judgement calls in this design
 *   are auditable rather than implicit.
 * - **Apply input.** Track ids are captured here in album sequence, so
 *   `--apply` writes playlists without touching Spotify's read endpoints.
 *
 * Resuming and re-scoring (`--rescore`) read the separate collect checkpoint
 * (checkpoint.ts), not this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScoredRelease } from './acclaim.js';
import type { Cluster } from './genre-map.js';
import type { Rejection } from './releases.js';

export const PLAN_VERSION = 1;

export interface PlannedRelease extends ScoredRelease {
  /** Track ids in album sequence. */
  trackIds: string[];
  trackNames: string[];
  /** `YYYY.MM` bucket — also the name of the playlist it lands in. */
  month: string;
}

export interface YearPlan {
  version: number;
  year: number;
  generatedAt: string;
  config: {
    streamingWeight: number;
    criticWeight: number;
    minLastfmListeners: number;
    floorPercentile: number;
    coCitationThreshold: number;
    candidateLimit: number;
  };
  stats: {
    seeds: number;
    seedsUnresolved: number;
    candidatesDiscovered: number;
    candidatesAfterCoCitation: number;
    candidatesScored: number;
    artistsSearched: number;
    releasesQualified: number;
    releasesAfterFloor: number;
    trackTotal: number;
    criticFallbacks: number;
    fallbackByCluster: Record<string, number>;
    releasesByCluster: Record<string, number>;
    releasesByMonth: Record<string, number>;
    /** Failed API calls per phase — a plan that lost data must say so. */
    failures: Record<string, number>;
    attempts: Record<string, number>;
  };
  releases: PlannedRelease[];
  /** Releases cut by the acclaim floor — kept for review, not applied. */
  cutByFloor: Array<{
    artistName: string;
    name: string;
    cluster: Cluster;
    acclaim: number;
  }>;
  rejections: Rejection[];
}

/** Month bucket for a release date of any precision. */
export function monthOf(releaseDate: string, year: number): string {
  const month = releaseDate.length >= 7 ? releaseDate.slice(5, 7) : '01';
  return `${year}.${month}`;
}

export function planPath(dataDir: string, year: number): string {
  return join(dataDir, `year-plan-${year}.json`);
}

export function summaryPath(dataDir: string, year: number): string {
  return join(dataDir, `year-plan-${year}.md`);
}

export function savePlan(path: string, plan: YearPlan): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2));
}

export function loadPlan(path: string): YearPlan | null {
  if (!existsSync(path)) return null;
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8')) as YearPlan;
    if (plan.version !== PLAN_VERSION) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * Order releases for a month: by date, ties broken by acclaim descending.
 *
 * Tracks stay contiguous within a release and in album sequence — Q13 settled
 * that re-sorting an album by popularity is a subtler form of the truncation
 * that was already rejected.
 */
export function orderedForMonth(
  plan: YearPlan,
  month: string,
): PlannedRelease[] {
  return plan.releases
    .filter((r) => r.month === month)
    .sort(
      (a, b) =>
        a.releaseDate.localeCompare(b.releaseDate) || b.acclaim - a.acclaim,
    );
}

/** Every month present in the plan, chronologically. */
export function months(plan: YearPlan): string[] {
  return [...new Set(plan.releases.map((r) => r.month))].sort();
}

// ── Markdown summary ────────────────────────────────────────────────────────

export function renderSummary(plan: YearPlan): string {
  const s = plan.stats;
  const lines: string[] = [];

  lines.push(`# ${plan.year} year collection — plan`);
  lines.push('');
  lines.push(`Generated ${plan.generatedAt}`);
  lines.push('');
  lines.push('## Funnel');
  lines.push('');
  lines.push('```');
  lines.push(
    `seeds (P1+P2)              ${s.seeds} (${s.seedsUnresolved} unresolved)`,
  );
  lines.push(`candidates discovered      ${s.candidatesDiscovered}`);
  lines.push(
    `after co-citation >= ${plan.config.coCitationThreshold}      ${s.candidatesAfterCoCitation}`,
  );
  lines.push(`candidates scored          ${s.candidatesScored}`);
  lines.push(`after relevance cut        ${s.artistsSearched} (searched)`);
  lines.push(`releases qualified         ${s.releasesQualified}`);
  lines.push(`after acclaim floor        ${s.releasesAfterFloor}`);
  lines.push(`tracks                     ${s.trackTotal}`);
  lines.push('```');
  lines.push('');

  const failedPhases = Object.entries(s.failures ?? {}).filter(
    ([, count]) => count > 0,
  );
  if (failedPhases.length) {
    lines.push('## Failed calls');
    lines.push('');
    lines.push(
      'Calls that failed after their retries were exhausted. Spotify failures ' +
        'mean missing data — a dropped album batch yields releases with no ' +
        'tracks, a dropped artist batch yields wrong cluster assignment. ' +
        'Deezer and Last.fm misses are expected and degrade gracefully.',
    );
    lines.push('');
    lines.push('| Phase | Failed | Attempted | Rate |');
    lines.push('|---|---|---|---|');
    for (const [phase, count] of failedPhases.sort((a, b) => b[1] - a[1])) {
      const attempts = s.attempts?.[phase] ?? 0;
      const rate = attempts ? ((count / attempts) * 100).toFixed(1) : '—';
      lines.push(`| ${phase} | ${count} | ${attempts} | ${rate}% |`);
    }
    lines.push('');
  }

  lines.push('## Last.fm coverage');
  lines.push('');
  lines.push(
    `${s.criticFallbacks} of ${s.releasesAfterFloor} releases scored on streaming alone ` +
      `(below ${plan.config.minLastfmListeners} listeners). By cluster:`,
  );
  lines.push('');
  lines.push('| Cluster | Releases | Critic fallback | Share |');
  lines.push('|---|---|---|---|');
  for (const [cluster, total] of Object.entries(s.releasesByCluster).sort(
    (a, b) => b[1] - a[1],
  )) {
    const fallback = s.fallbackByCluster[cluster] ?? 0;
    const share = total ? Math.round((fallback / total) * 100) : 0;
    lines.push(`| ${cluster} | ${total} | ${fallback} | ${share}% |`);
  }
  lines.push('');

  lines.push('## Playlists');
  lines.push('');
  lines.push('| Month | Releases | Tracks |');
  lines.push('|---|---|---|');
  for (const month of months(plan)) {
    const releases = orderedForMonth(plan, month);
    const tracks = releases.reduce((sum, r) => sum + r.trackIds.length, 0);
    lines.push(`| ${month} | ${releases.length} | ${tracks} |`);
  }
  lines.push('');

  lines.push('## Releases by month');
  for (const month of months(plan)) {
    lines.push('');
    lines.push(`### ${month}`);
    lines.push('');
    for (const release of orderedForMonth(plan, month)) {
      const flag = release.criticFallback ? ' _(streaming only)_' : '';
      lines.push(
        `- \`${release.releaseDate}\` **${release.artistName} — ${release.name}** ` +
          `· ${release.trackIds.length}t · ${release.cluster} · ` +
          `acclaim ${release.acclaim.toFixed(3)}${flag}`,
      );
    }
  }
  lines.push('');

  if (plan.cutByFloor.length) {
    lines.push('## Cut by acclaim floor');
    lines.push('');
    for (const release of plan.cutByFloor.slice(0, 200)) {
      lines.push(
        `- ${release.artistName} — ${release.name} · ${release.cluster} · ${release.acclaim.toFixed(3)}`,
      );
    }
    if (plan.cutByFloor.length > 200) {
      lines.push(`- _…and ${plan.cutByFloor.length - 200} more_`);
    }
    lines.push('');
  }

  const byReason = new Map<string, number>();
  for (const rejection of plan.rejections) {
    const key = rejection.reason.split(' ')[0];
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  lines.push('## Rejected releases');
  lines.push('');
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${reason}\` — ${count}`);
  }
  lines.push('');

  return lines.join('\n');
}
