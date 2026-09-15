/**
 * Crash and disconnect recovery for the collect phase.
 *
 * A full run is roughly two hours, almost all of it spent waiting on Spotify's
 * one-request-per-second pacer. Without a checkpoint, losing the terminal at
 * minute 110 costs the whole run, so each expensive phase writes its output
 * here as soon as it completes, and the two longest loops — candidate
 * resolution and the album sweep — also write incrementally as they go.
 *
 * The file is deliberately separate from the plan: a plan is a reviewable
 * result, this is disposable machinery. `--fresh` deletes it.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcclaimSignals } from './acclaim.js';
import type { RawCandidate } from './expansion.js';
import type { Cluster } from './genre-map.js';
import type { ArtistProfile, Candidate } from './index.js';
import type { AlbumDetail, Rejection, YearRelease } from './releases.js';

export const CHECKPOINT_VERSION = 1;

/** How often the long loops flush, in items. */
export const FLUSH_EVERY = 25;

export interface Checkpoint {
  version: number;
  year: number;
  updatedAt: string;
  /** Failed API calls per phase — surfaced so degradation is never silent. */
  failures: Record<string, number>;
  /** Items attempted per phase, for the failure-rate check. */
  attempts: Record<string, number>;

  rosterProfiles?: Array<[string, ArtistProfile]>;
  expansion?: {
    candidates: Array<[string, RawCandidate]>;
    seedRelations: Array<[string, string[]]>;
    seedsUnresolved: number;
  };
  resolution?: {
    /** Survivors consumed so far, so a resume skips them. */
    doneCount: number;
    resolved: Candidate[];
  };
  albums?: {
    doneArtistIds: string[];
    releases: Array<YearRelease & { cluster: Cluster }>;
    rejections: Rejection[];
  };
  details?: Array<[string, AlbumDetail]>;
  deezerAcclaim?: Array<[string, number]>;
  lastfmAcclaim?: Array<[string, { listeners: number; playcount: number }]>;
}

export function checkpointPath(dataDir: string, year: number): string {
  return join(dataDir, `year-plan-${year}.progress.json`);
}

export function loadCheckpoint(path: string, year: number): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
    if (parsed.version !== CHECKPOINT_VERSION || parsed.year !== year) {
      return null;
    }
    return parsed;
  } catch {
    // A checkpoint torn by a kill mid-write is not worth recovering; the
    // alternative is resuming from corrupt state, which is worse.
    return null;
  }
}

/**
 * Write atomically — a process killed mid-write would otherwise leave a
 * truncated file, and this is exactly the situation the file exists for.
 */
export function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  checkpoint.updatedAt = new Date().toISOString();
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(checkpoint));
  renameSync(temp, path);
}

export function clearCheckpoint(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
}

export function emptyCheckpoint(year: number): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    year,
    updatedAt: new Date().toISOString(),
    failures: {},
    attempts: {},
  };
}

// ── Failure accounting ──────────────────────────────────────────────────────

/**
 * Counts failed calls per phase.
 *
 * `apiCall` returns `{success:false}` rather than throwing, and every caller
 * in this pipeline treats that as "nothing found" — which is correct for a
 * genuinely empty result and catastrophic for a network outage. Counting the
 * difference is what lets the run refuse to pass off a degraded plan as whole.
 */
export interface PhaseReporter {
  attempt(n?: number): void;
  fail(n?: number): void;
}

export class FailureLog {
  constructor(private readonly checkpoint: Checkpoint) {}

  record(phase: string, count = 1): void {
    this.checkpoint.failures[phase] =
      (this.checkpoint.failures[phase] ?? 0) + count;
  }

  attempt(phase: string, count = 1): void {
    this.checkpoint.attempts[phase] =
      (this.checkpoint.attempts[phase] ?? 0) + count;
  }

  /** A reporter bound to one phase, for passing into a fetch helper. */
  for(phase: string): PhaseReporter {
    return {
      attempt: (n = 1) => this.attempt(phase, n),
      fail: (n = 1) => this.record(phase, n),
    };
  }

  get failures(): Record<string, number> {
    return this.checkpoint.failures;
  }

  get attempts(): Record<string, number> {
    return this.checkpoint.attempts;
  }
}

export interface DegradedPhase {
  phase: string;
  failures: number;
  attempts: number;
  rate: number;
}

/**
 * Failure rate at which a phase is considered to have corrupted the run.
 *
 * Spotify phases get a low bar because their failures are invisible in the
 * output: a skipped album batch yields a release with no tracks, a skipped
 * artist batch yields a wrong cluster assignment.
 *
 * Deezer and Last.fm are different — a miss there is *expected*, since plenty
 * of releases genuinely are not in those catalogs, and the acclaim blend is
 * built to degrade to the remaining signals. Only a rate high enough to mean
 * "the service is down" counts.
 */
export const PHASE_THRESHOLDS: Record<string, number> = {
  'deezer acclaim': 0.6,
  'lastfm acclaim': 0.6,
};

export const DEFAULT_THRESHOLD = 0.02;

/** Phases whose failure rate crosses their threshold. */
export function degradedPhases(log: FailureLog): DegradedPhase[] {
  const out: DegradedPhase[] = [];
  for (const [phase, failures] of Object.entries(log.failures)) {
    const attempts = log.attempts[phase] ?? 0;
    if (attempts === 0 || failures === 0) continue;
    const rate = failures / attempts;
    const threshold = PHASE_THRESHOLDS[phase] ?? DEFAULT_THRESHOLD;
    if (rate >= threshold) out.push({ phase, failures, attempts, rate });
  }
  return out.sort((a, b) => b.rate - a.rate);
}

export type { AcclaimSignals };
