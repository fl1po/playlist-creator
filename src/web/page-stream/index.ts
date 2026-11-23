/**
 * The page stream (CONTEXT.md): everything the server sends one signed-in
 * page, and what the page does about each message. The server imports this
 * module for the message types and the history policy; the browser loads its
 * compiled output as-is (ADR-0012), so nothing here may import a value from
 * outside `lib/task-progress.ts`. Types are free: `import type` is erased.
 *
 * The page is an adapter: it feeds every message to `receive` and carries
 * out the effects. Every rule about what a message means lives here.
 */
import type { UserTokens } from '../../lib/types.js';
import type { BaseEvents, TaskStatus } from '../task-runner.js';
import type { AwBreakdownResults } from '../tasks/aw-breakdown.js';
import type { ClearResults } from '../tasks/clear.js';
import type { DedupRemoveResults } from '../tasks/dedup-remove.js';
import type { DedupScanResults } from '../tasks/dedup-scan.js';
import type { FillResults } from '../tasks/fill.js';
import type { ListeningTimeResults } from '../tasks/listening-time.js';
import type { RecalculateResults } from '../tasks/recalculate.js';

export { PROGRESS_BARS } from '../../lib/task-progress.js';

import type {
  ProgressBarKey,
  ProgressUpdate,
  ProgressView,
  StepState,
} from '../../lib/task-progress.js';

// ── Messages ────────────────────────────────────────────────────────────────

/** Every task result, by message type (CONTEXT.md: task result). */
export type TaskResults = FillResults &
  RecalculateResults &
  ClearResults &
  DedupScanResults &
  DedupRemoveResults &
  ListeningTimeResults &
  AwBreakdownResults;

/** What this process runs, as the restart marker names it. */
export interface DeployInfo {
  commit?: string;
  message?: string;
  branch?: string;
}

export type LogData = BaseEvents['log'] & { ts?: number };

/**
 * The task runner's status for this page's user. The owner's progress is the
 * full view on connect and at a run's start, then live updates.
 */
export type StatusData =
  | Exclude<TaskStatus, { mine: true }>
  | (Omit<Extract<TaskStatus, { mine: true }>, 'progress'> & {
      progress?: ProgressView | ProgressUpdate;
    });

/** Every message's data, by type. */
export interface StreamData extends TaskResults {
  /** The connecting page's history has all been sent. */
  'replay:done': null;
  /** The log was cleared since the page's last event; a full replay follows. */
  'replay:reset': null;
  /** What this page's user may know of the task slot (ADR-0003, ADR-0006). */
  status: StatusData;
  log: LogData;
  /** Marks a deploy in the history: whatever ran before it was cut off. */
  'server:restarted': DeployInfo;
  auth: { authenticated: true } | { authenticated: false; url?: string };
  /** Rotated bearer tokens, for the page to keep. */
  'data:save': { key: 'tokens'; value: UserTokens };
  /** A new page build is out. */
  reload: null;
}

export type StreamType = keyof StreamData;

export type StreamMessage = {
  [K in StreamType]: {
    type: K;
    data: StreamData[K];
    /** When the server sent it. */
    ts?: number;
    /** The task that produced it, for the log's process filter. */
    task?: string;
  };
}[StreamType];

export const REPLAY_DONE = 'replay:done' satisfies StreamType;
export const REPLAY_RESET = 'replay:reset' satisfies StreamType;

// ── History policy ──────────────────────────────────────────────────────────

/**
 * What becomes of a message after it is sent:
 * - `transient`: never replayed; it describes the moment it was sent.
 * - `replayed`: replayed to a reconnecting page, but not persisted, and not
 *   kept in the page's own cache (an old token push would undo a newer one).
 * - `kept`: part of the history, persisted and cached by the page.
 */
export type Retention = 'transient' | 'replayed' | 'kept';

const RETENTION: Record<StreamType, Retention> = {
  'replay:done': 'transient',
  'replay:reset': 'transient',
  status: 'transient',
  auth: 'transient',
  reload: 'transient',
  'data:save': 'replayed',
  log: 'kept',
  'server:restarted': 'kept',
  'fill:recalculated': 'kept',
  'fill:complete': 'kept',
  'fill:stopped': 'kept',
  'recalc:complete': 'kept',
  'clear:complete': 'kept',
  'dedup:scanComplete': 'kept',
  'dedup:complete': 'kept',
  'listeningTime:complete': 'kept',
  'awBreakdown:complete': 'kept',
};

/** A type this module doesn't know is kept, as everything was before. */
export function retentionOf(type: string): Retention {
  return (RETENTION as Record<string, Retention | undefined>)[type] ?? 'kept';
}

/** How much history the server keeps for replay, and the page caches. */
export const HISTORY = {
  maxEntries: 2000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

// ── Receiving ───────────────────────────────────────────────────────────────

export type ReloadTarget = 'artists' | 'aiPicks' | 'stats';

export interface TaskView {
  busy: boolean;
  /** Whether this page's user owns the running task. */
  mine: boolean;
  /** Named only to the owner. */
  name: string | null;
  stopping: boolean;
}

export interface PageStreamState {
  /** True until the first connection's history has all been received. */
  replaying: boolean;
  task: TaskView;
  /** Names the running task has marked (the artists a fill has searched). */
  marked: ReadonlySet<string>;
  /** The newest marked name: the artist being searched now. */
  current: string | null;
  /** The live scan removal would act on; only a live scan arms it. */
  dedupScan: TaskResults['dedup:scanComplete'] | null;
}

/** What the page knows that the stream doesn't. */
export interface PageFacts {
  /** The page is showing its session-expired banner. */
  sessionExpired: boolean;
  /** The tokens the page holds, in bearer mode. */
  tokens: UserTokens | null;
  /** This window opened a Spotify login that hasn't finished. */
  loginPending: boolean;
}

export interface ProgressDraw {
  steps: Array<{ label: string; state: StepState }>;
  bars: Array<{
    key: ProgressBarKey;
    value: number;
    total: number;
    text: string;
  }>;
  waitUntil: number | null;
}

export type Effect =
  | {
      kind: 'log';
      level: LogData['level'];
      message: string;
      ts?: number;
      task?: string;
    }
  /** Fetch these again; the page coalesces a burst into one fetch each. */
  | { kind: 'reload'; targets: ReloadTarget[] }
  | { kind: 'task'; view: TaskView; statusText: string }
  /** Draw the owner's progress, or none. */
  | { kind: 'progress'; progress: ProgressDraw | null }
  /**
   * Re-mark the artist rows: `reset` clears them and marks `done` as done;
   * otherwise `searched` adds to them, the last one being searched now.
   */
  | { kind: 'marks'; reset: boolean; done: string[]; searched: string[] }
  | { kind: 'dedupArmed'; armed: boolean }
  | {
      kind: 'show';
      result: 'listeningTime';
      data: TaskResults['listeningTime:complete'];
    }
  | {
      kind: 'show';
      result: 'awBreakdown';
      data: TaskResults['awBreakdown:complete'];
    }
  /** Empty the log panel and the page's cached history. */
  | { kind: 'resetLog' }
  | { kind: 'storeTokens'; tokens: UserTokens }
  | { kind: 'showSessionExpired' }
  | { kind: 'reloadPage' };

export const initialState: PageStreamState = {
  replaying: true,
  task: { busy: false, mine: false, name: null, stopping: false },
  marked: new Set(),
  current: null,
  dedupScan: null,
};

export interface Received {
  state: PageStreamState;
  effects: Effect[];
}

/**
 * What one message means to the page. Pure: the page holds the state between
 * calls and carries out the effects in order.
 */
export function receive(
  state: PageStreamState,
  message: StreamMessage,
  page: PageFacts,
): Received {
  const { ts, task } = message;
  // Replayed history is already reflected in what the page loads on
  // startup; a reconnect's replay carries what the page missed, so it does
  // reload.
  const reload = (...targets: ReloadTarget[]): Received => ({
    state,
    effects: state.replaying ? [] : [{ kind: 'reload', targets }],
  });

  switch (message.type) {
    case 'replay:done':
      return { state: { ...state, replaying: false }, effects: [] };
    case 'replay:reset':
      return { state, effects: [{ kind: 'resetLog' }] };

    case 'status':
      return receiveStatus(state, message.data);

    case 'log':
      return {
        state,
        effects: [
          {
            kind: 'log',
            level: message.data.level || 'info',
            message: message.data.message,
            ts: message.data.ts ?? ts,
            task,
          },
        ],
      };
    case 'server:restarted': {
      const d = message.data;
      const deployed = d?.commit
        ? ` — deployed ${d.commit}${d.message ? ` "${d.message}"` : ''}${d.branch ? ` (${d.branch})` : ''}`
        : '';
      return {
        state,
        effects: [
          {
            kind: 'log',
            level: 'warn',
            message: `Server restarted${deployed}. Anything running before this was cut off`,
            ts,
            task,
          },
        ],
      };
    }

    // Task results: their lines arrive as log messages (ADR-0007).
    case 'fill:complete':
    case 'fill:stopped': // a stopped fill keeps the weeks it finished
      return reload('artists', 'aiPicks', 'stats');
    case 'fill:recalculated':
      return reload('artists');
    case 'recalc:complete':
      return reload('artists', 'stats');
    case 'clear:complete': // a cleared weekly playlist's AI picks go with it
      return reload('aiPicks');

    case 'dedup:scanComplete':
      // A replayed scan may be days old; removing by it could take out
      // tracks added since, so only a scan seen live arms removal.
      if (state.replaying) return { state, effects: [] };
      return {
        state: { ...state, dedupScan: message.data },
        effects: [
          { kind: 'dedupArmed', armed: message.data.totalDuplicates > 0 },
        ],
      };
    case 'dedup:complete':
      return {
        state: { ...state, dedupScan: null },
        effects: [{ kind: 'dedupArmed', armed: false }],
      };

    case 'listeningTime:complete':
      return {
        state,
        effects: [
          { kind: 'show', result: 'listeningTime', data: message.data },
        ],
      };
    case 'awBreakdown:complete':
      return {
        state,
        effects: [{ kind: 'show', result: 'awBreakdown', data: message.data }],
      };

    case 'auth':
      if (!message.data.authenticated) {
        // The inline banner (manual refresh), not the full login overlay,
        // so the page stays usable.
        return { state, effects: [{ kind: 'showSessionExpired' }] };
      }
      // This window's own login completes through its popup, which must
      // store the new tokens first; the user's other pages just reload.
      return {
        state,
        effects: page.loginPending ? [] : [{ kind: 'reloadPage' }],
      };

    case 'data:save': {
      const next = message.data.value;
      if (message.data.key !== 'tokens' || !next) return { state, effects: [] };
      const changed =
        page.tokens?.accessToken !== next.accessToken ||
        page.tokens?.refreshToken !== next.refreshToken;
      // Another device refreshed while this one shows the expired banner:
      // reload onto the new pair, as a local refresh would. Only on a
      // change, so a replayed push of the same pair can't loop.
      const effects: Effect[] = [{ kind: 'storeTokens', tokens: next }];
      if (changed && page.sessionExpired) effects.push({ kind: 'reloadPage' });
      return { state, effects };
    }

    case 'reload':
      return { state, effects: [{ kind: 'reloadPage' }] };
  }
  return unknownMessage(state, message);
}

/** A message type from a newer server than this page: ignored. */
function unknownMessage(state: PageStreamState, _never: never): Received {
  return { state, effects: [] };
}

function receiveStatus(state: PageStreamState, status: StatusData): Received {
  const mine = status.busy && status.mine;
  const view: TaskView = {
    busy: status.busy,
    mine,
    name: mine ? status.task : null,
    stopping: mine ? status.stopping : false,
  };
  // Only the owner learns which task is running (ADR-0003).
  const statusText = view.name
    ? `Running: ${view.name}`
    : view.busy
      ? 'Busy: another user’s task'
      : 'Connected';

  const progress = mine ? status.progress : undefined;
  const effects: Effect[] = [
    { kind: 'task', view, statusText },
    {
      kind: 'progress',
      progress: progress
        ? {
            steps: progress.steps,
            bars: progress.bars,
            waitUntil: progress.waitUntil ?? null,
          }
        : null,
    },
  ];

  let { marked, current, dedupScan } = state;
  // A full list (the connect snapshot, a run's start, or no progress at
  // all) replaces the marks; a live update only adds to them.
  if (!progress || 'marked' in progress) {
    marked = new Set(progress && 'marked' in progress ? progress.marked : []);
    current = null;
    effects.push({
      kind: 'marks',
      reset: true,
      done: [...marked],
      searched: [],
    });
  } else if (progress.markedAdded.length) {
    const added = progress.markedAdded;
    marked = new Set([...marked, ...added]);
    current = added[added.length - 1];
    effects.push({ kind: 'marks', reset: false, done: [], searched: added });
  }

  // A new scan replaces the old one: removal waits for its result.
  if (view.name === 'dedup-scan' && dedupScan) {
    dedupScan = null;
    effects.push({ kind: 'dedupArmed', armed: false });
  }

  return {
    state: { ...state, task: view, marked, current, dedupScan },
    effects,
  };
}
