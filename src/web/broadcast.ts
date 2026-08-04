import type { Response } from 'express';

export interface Broadcaster {
  broadcast(type: string, data: unknown): void;
  broadcastTo(userId: string, type: string, data: unknown): void;
  addClient(
    res: Response,
    userId: string | null,
    currentTask: string | null,
    searchedArtists: ReadonlySet<string>,
    lastEventId?: string | null,
  ): void;
  removeClient(res: Response): void;
  clearHistory(): void;
}

const MAX_LOG_HISTORY = 500;

/**
 * Changes on every process start. Event ids are `<boot>-<seq>`, so a client
 * resuming with an id minted by a previous process replays from scratch
 * instead of skipping the new history.
 */
const BOOT_ID = Date.now().toString(36);

interface HistoryEntry {
  seq: number;
  msg: string;
}

/** Position to resume from, or 0 to replay everything. */
function resumeSeq(lastEventId: string | null | undefined): number {
  if (!lastEventId) return 0;
  const sep = lastEventId.lastIndexOf('-');
  if (sep < 0 || lastEventId.slice(0, sep) !== BOOT_ID) return 0;
  const seq = Number(lastEventId.slice(sep + 1));
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

export function createBroadcaster(): Broadcaster {
  const clients = new Map<Response, string | null>(); // res -> userId
  const logHistory = new Map<string, HistoryEntry[]>(); // userId -> messages
  let seq = 0;

  function send(res: Response, msg: string, eventId?: string) {
    if (res.writableEnded) return;
    res.write(
      eventId ? `id: ${eventId}\ndata: ${msg}\n\n` : `data: ${msg}\n\n`,
    );
  }

  function getUserHistory(userId: string): HistoryEntry[] {
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
    return { ...(data as object), ts: d.ts ?? Date.now() };
  }

  /** Broadcast to ALL connected clients (used for global events like reload) */
  function broadcast(type: string, data: unknown) {
    const msg = JSON.stringify({
      type,
      data: stampLog(type, data),
      ts: Date.now(),
    });
    for (const [res] of clients) send(res, msg);
  }

  /** Broadcast to a specific user's clients only */
  function broadcastTo(userId: string, type: string, data: unknown) {
    // Every message is stamped, not just `log` ones: the client renders log
    // lines out of task events too, and on replay those must show when the
    // event happened rather than when the client re-rendered it.
    const msg = JSON.stringify({
      type,
      data: stampLog(type, data),
      ts: Date.now(),
    });
    // Every message is numbered so a reconnecting client can tell the server
    // where it left off; only the durable ones are kept for replay.
    seq += 1;
    if (!SKIP_HISTORY.has(type)) {
      const history = getUserHistory(userId);
      history.push({ seq, msg });
      if (history.length > MAX_LOG_HISTORY)
        history.splice(0, history.length - MAX_LOG_HISTORY);
    }
    const eventId = `${BOOT_ID}-${seq}`;
    for (const [res, uid] of clients) {
      if (uid === userId) send(res, msg, eventId);
    }
  }

  function addClient(
    res: Response,
    userId: string | null,
    currentTask: string | null,
    searchedArtists: ReadonlySet<string>,
    lastEventId?: string | null,
  ) {
    clients.set(res, userId);
    send(
      res,
      JSON.stringify({
        type: 'status',
        data: { busy: !!currentTask, task: currentTask },
      }),
    );
    if (searchedArtists.size > 0) {
      send(
        res,
        JSON.stringify({
          type: 'fill:searchedArtists',
          data: [...searchedArtists],
        }),
      );
    }
    // Replay user history from where this client left off. EventSource resends
    // its last id automatically, so a dropped connection (idle proxy timeout,
    // sleeping tab) resumes instead of re-appending the whole log.
    if (userId) {
      const from = resumeSeq(lastEventId);
      for (const entry of logHistory.get(userId) ?? []) {
        if (entry.seq > from) send(res, entry.msg, `${BOOT_ID}-${entry.seq}`);
      }
    }
    res.on('close', () => clients.delete(res));
  }

  function removeClient(res: Response) {
    clients.delete(res);
  }

  function clearHistory() {
    logHistory.clear();
  }

  return { broadcast, broadcastTo, addClient, removeClient, clearHistory };
}
