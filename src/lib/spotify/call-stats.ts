import { formatElapsed } from '../task-log.js';
import type { Lane } from './pacer.js';

/**
 * Counts the calls each user's gateway makes to Spotify, so a rate limit can
 * be traced to what spent it. Every attempt counts — retries included —
 * since each one is a request against the app's limit.
 */

/** One attempt that reached Spotify, as the gateway reports it. */
export interface SpotifyCall {
  lane: Lane;
  description: string;
  outcome: 'ok' | 'rate_limited' | 'failed';
  retryAfterSeconds?: number;
  /**
   * Time from asking the pacer to being let through. It includes the base
   * interval itself, not only queuing behind other calls: at 1 req/s a lone
   * task still waits most of a second per call.
   */
  queuedMs?: number;
}

export interface CallTally {
  calls: number;
  rateLimited: number;
  failed: number;
  /** Calls per kind, split by who made them: the page or a task. */
  byKind: Record<string, { page: number; task: number }>;
}

export interface CallSummary {
  level: 'debug' | 'warn';
  message: string;
}

export interface CallStats {
  record(userId: string, call: SpotifyCall): void;
  /** Report each user's calls since the last report, then start a new window. */
  report(): void;
  /** The user's calls since the process started. */
  totals(userId: string): CallTally;
}

/** What a call was, without the ids, names and numbers that vary per call. */
export function callKind(description: string): string {
  return description
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b[0-9A-Za-z]{22}\b/g, '…')
    .replace(/\d+/g, '#');
}

const emptyTally = (): CallTally => ({
  calls: 0,
  rateLimited: 0,
  failed: 0,
  byKind: {},
});

/** Kinds named in a summary; the rest are only counted. */
const SUMMARY_KINDS = 8;

function describeKind(
  kind: string,
  { page, task }: { page: number; task: number },
): string {
  const who =
    page && task ? `${page} page, ${task} task` : page ? 'page' : 'task';
  return `${kind} ×${page + task} (${who})`;
}

/** A window's tally, with its longest Retry-After and its pacer waits. */
interface WindowTally extends CallTally {
  maxRetryAfterS: number;
  queuedMs: { page: number; task: number };
}

/** Pacer waits under this, page and task together, go unmentioned. */
const QUEUED_MENTION_MS = 1000;

function describeQueued({ queuedMs }: WindowTally): string {
  if (queuedMs.page + queuedMs.task < QUEUED_MENTION_MS) return '';
  const sides = (['task', 'page'] as const).filter((who) => queuedMs[who]);
  return `; waited for pacer: ${sides
    .map((who) => `${who} ${formatElapsed(queuedMs[who])}`)
    .join(', ')}`;
}

export function createCallStats(opts: {
  report: (userId: string, summary: CallSummary) => void;
  /** Window length named in summaries; the caller schedules `report`. */
  windowMinutes?: number;
}): CallStats {
  const windowMinutes = opts.windowMinutes ?? 5;
  const totals = new Map<string, CallTally>();
  let window = new Map<string, WindowTally>();

  function add(tally: CallTally, call: SpotifyCall) {
    tally.calls++;
    if (call.outcome === 'rate_limited') tally.rateLimited++;
    if (call.outcome === 'failed') tally.failed++;
    const kind = callKind(call.description);
    tally.byKind[kind] ??= { page: 0, task: 0 };
    tally.byKind[kind][call.lane === 'interactive' ? 'page' : 'task']++;
  }

  return {
    record(userId, call) {
      let total = totals.get(userId);
      if (!total) {
        total = emptyTally();
        totals.set(userId, total);
      }
      add(total, call);

      let current = window.get(userId);
      if (!current) {
        current = {
          ...emptyTally(),
          maxRetryAfterS: 0,
          queuedMs: { page: 0, task: 0 },
        };
        window.set(userId, current);
      }
      add(current, call);
      current.queuedMs[call.lane === 'interactive' ? 'page' : 'task'] +=
        call.queuedMs ?? 0;
      if (call.retryAfterSeconds != null) {
        current.maxRetryAfterS = Math.max(
          current.maxRetryAfterS,
          call.retryAfterSeconds,
        );
      }
    },

    report() {
      const ended = window;
      window = new Map();
      for (const [userId, t] of ended) {
        const kinds = Object.entries(t.byKind).sort(
          ([, a], [, b]) => b.page + b.task - (a.page + a.task),
        );
        let message = `Spotify calls (last ${windowMinutes} min): ${t.calls} — ${kinds
          .slice(0, SUMMARY_KINDS)
          .map(([kind, counts]) => describeKind(kind, counts))
          .join(', ')}`;
        if (kinds.length > SUMMARY_KINDS) {
          message += `, +${kinds.length - SUMMARY_KINDS} more kinds`;
        }
        message += describeQueued(t);
        if (t.failed) message += `; failed: ${t.failed}`;
        if (t.rateLimited) {
          const wait = t.maxRetryAfterS
            ? ` (Retry-After up to ${t.maxRetryAfterS}s)`
            : '';
          message += `; 429s: ${t.rateLimited}${wait}`;
        }
        opts.report(userId, {
          level: t.rateLimited ? 'warn' : 'debug',
          message,
        });
      }
    },

    totals(userId) {
      return totals.get(userId) ?? emptyTally();
    },
  };
}
