import type { Response } from 'express';
import type { LogStore, StoredEntry } from './log-store.js';

export interface Broadcaster {
  broadcast(type: string, data: unknown): void;
  /**
   * `task` names the process that produced the message (e.g. "fill"); it rides
   * on the envelope so the client can filter the log by process. Omit it for
   * messages no process owns (auth, config).
   */
  broadcastTo(userId: string, type: string, data: unknown, task?: string): void;
  /**
   * Send every connected client its own payload, computed from its user
   * (`null` when not signed in). Transient: not numbered, never replayed.
   */
  broadcastEach(
    type: string,
    dataFor: (userId: string | null) => unknown,
  ): void;
  /** Register messages every newly connected client receives before its history replay. */
  onConnect(snapshot: (userId: string | null) => SnapshotMessage[]): void;
  addClient(
    res: Response,
    userId: string | null,
    lastEventId?: string | null,
  ): void;
  removeClient(res: Response): void;
  /** Forget the user's log, here and in the store. */
  clearHistory(userId: string): Promise<void>;
  /** Write entries not yet in the store. */
  flush(): Promise<void>;
  /**
   * Load each user's last week from the store into the replay history, then
   * mark the restart so the client ends any run the restart cut off.
   */
  restore(): Promise<void>;
  /** The user's last week of history messages, oldest first. */
  week(userId: string): Promise<HistoryMessage[]>;
}

export interface HistoryMessage {
  type: string;
  data: unknown;
  ts: number;
  task?: string;
}

export interface BroadcasterOptions {
  /** Where history persists across restarts; none keeps it in memory only. */
  store?: LogStore | null;
  now?: () => number;
}

export interface SnapshotMessage {
  type: string;
  data: unknown;
}

/** Entries kept in memory for replay; the store holds the full week. */
const MAX_LOG_HISTORY = 2000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Ceiling on entries waiting for the store while it keeps failing. */
const MAX_PENDING = 5000;

/**
 * Position to resume from, or 0 to replay everything. Ids are sequence
 * numbers that keep rising across restarts, so a client's id from before a
 * deploy still says where it left off in the restored history.
 */
function resumeSeq(lastEventId: string | null | undefined): number {
  if (!lastEventId) return 0;
  const seq = Number(lastEventId);
  return Number.isFinite(seq) ? seq : 0;
}

/** High-frequency or transient types that should not be stored. */
const SKIP_HISTORY = new Set([
  'status',
  'reload',
  'auth',
  'fill:searchProgress',
  'recalc:scanProgress',
  'listeningTime:progress',
]);

/** Replayed, but not worth persisting: the browser's storage mirror. */
const SKIP_PERSIST = new Set(['data:save']);

export function createBroadcaster(opts: BroadcasterOptions = {}): Broadcaster {
  const { store = null, now = Date.now } = opts;
  const clients = new Map<Response, string | null>(); // res -> userId
  const logHistory = new Map<string, StoredEntry[]>(); // userId -> messages
  const pending = new Map<string, StoredEntry[]>(); // userId -> not yet stored
  const snapshots: Array<(userId: string | null) => SnapshotMessage[]> = [];
  // Starts at the clock so ids keep rising across restarts (see resumeSeq).
  let seq = 0;
  const nextSeq = () => {
    seq = Math.max(seq + 1, now());
    return seq;
  };

  function send(res: Response, msg: string, eventId?: string) {
    if (res.writableEnded) return;
    res.write(
      eventId ? `id: ${eventId}\ndata: ${msg}\n\n` : `data: ${msg}\n\n`,
    );
  }

  function getUserHistory(userId: string): StoredEntry[] {
    let h = logHistory.get(userId);
    if (!h) {
      h = [];
      logHistory.set(userId, h);
    }
    return h;
  }

  function stampLog(type: string, data: unknown): unknown {
    if (type !== 'log' || !data || typeof data !== 'object') return data;
    const d = data as { ts?: number };
    return { ...(data as object), ts: d.ts ?? now() };
  }

  /** Broadcast to ALL connected clients (used for global events like reload) */
  function broadcast(type: string, data: unknown) {
    const msg = JSON.stringify({
      type,
      data: stampLog(type, data),
      ts: now(),
    });
    for (const [res] of clients) send(res, msg);
  }

  function broadcastTo(
    userId: string,
    type: string,
    data: unknown,
    task?: string,
  ) {
    // Every message is stamped, not just `log` ones: the client renders log
    // lines out of task events too, and on replay those must show when the
    // event happened rather than when the client re-rendered it.
    const ts = now();
    const msg = JSON.stringify({
      type,
      data: stampLog(type, data),
      ts,
      task,
    });
    // Every message is numbered so a reconnecting client can tell the server
    // where it left off; only the durable ones are kept for replay.
    const entry = { seq: nextSeq(), ts, msg };
    if (!SKIP_HISTORY.has(type)) {
      const history = getUserHistory(userId);
      history.push(entry);
      if (history.length > MAX_LOG_HISTORY)
        history.splice(0, history.length - MAX_LOG_HISTORY);
      if (store && !SKIP_PERSIST.has(type)) {
        pending.set(userId, [...(pending.get(userId) ?? []), entry]);
      }
    }
    const eventId = String(entry.seq);
    for (const [res, uid] of clients) {
      if (uid === userId) send(res, msg, eventId);
    }
  }

  function broadcastEach(
    type: string,
    dataFor: (userId: string | null) => unknown,
  ) {
    for (const [res, uid] of clients) {
      send(res, JSON.stringify({ type, data: dataFor(uid), ts: now() }));
    }
  }

  function onConnect(snapshot: (userId: string | null) => SnapshotMessage[]) {
    snapshots.push(snapshot);
  }

  function addClient(
    res: Response,
    userId: string | null,
    lastEventId?: string | null,
  ) {
    clients.set(res, userId);
    for (const snapshot of snapshots) {
      for (const m of snapshot(userId)) send(res, JSON.stringify(m));
    }
    // Replay user history from where this client left off. EventSource resends
    // its last id automatically, so a dropped connection (idle proxy timeout,
    // sleeping tab) resumes instead of re-appending the whole log.
    if (userId) {
      const from = resumeSeq(lastEventId);
      for (const entry of logHistory.get(userId) ?? []) {
        if (entry.seq > from) send(res, entry.msg, String(entry.seq));
      }
    }
    res.on('close', () => clients.delete(res));
  }

  function removeClient(res: Response) {
    clients.delete(res);
  }

  async function clearHistory(userId: string) {
    logHistory.delete(userId);
    pending.delete(userId);
    await store?.clear(userId);
  }

  async function flush() {
    if (!store) return;
    const batch = [...pending];
    pending.clear();
    await Promise.all(
      batch.map(async ([userId, entries]) => {
        try {
          await store.append(userId, entries);
        } catch (err) {
          // Keep them for the next flush, newest first if it has to give.
          const kept = [...entries, ...(pending.get(userId) ?? [])];
          pending.set(userId, kept.slice(-MAX_PENDING));
          console.error(`Log store append failed for ${userId}:`, err);
        }
      }),
    );
  }

  async function restore() {
    if (!store) return;
    for (const userId of await store.users()) {
      const entries = await store.load(userId, now() - RETENTION_MS);
      if (entries.length === 0) continue;
      const restored = entries.slice(-MAX_LOG_HISTORY);
      logHistory.set(userId, [...restored, ...(logHistory.get(userId) ?? [])]);
      seq = Math.max(seq, restored[restored.length - 1].seq);
      broadcastTo(userId, 'server:restarted', {});
    }
  }

  async function week(userId: string): Promise<HistoryMessage[]> {
    await flush();
    const entries = store
      ? await store.load(userId, now() - RETENTION_MS)
      : (logHistory.get(userId) ?? []);
    return entries.map((e) => JSON.parse(e.msg) as HistoryMessage);
  }

  return {
    broadcast,
    broadcastTo,
    broadcastEach,
    onConnect,
    addClient,
    removeClient,
    clearHistory,
    flush,
    restore,
    week,
  };
}
