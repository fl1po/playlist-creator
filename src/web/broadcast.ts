import type { Response } from 'express';
import type { EventHandlers, EventMap } from '../lib/service-events.js';

export interface Broadcaster {
  broadcast(type: string, data: unknown): void;
  broadcastTo(userId: string, type: string, data: unknown): void;
  addClient(
    res: Response,
    userId: string | null,
    currentTask: string | null,
    searchedArtists: ReadonlySet<string>,
  ): void;
  removeClient(res: Response): void;
  clearHistory(): void;
}

const MAX_LOG_HISTORY = 500;

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
  const logHistory = new Map<string, string[]>(); // userId -> messages

  function send(res: Response, msg: string) {
    if (!res.writableEnded) res.write(`data: ${msg}\n\n`);
  }

  function getUserHistory(userId: string): string[] {
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
    const msg = JSON.stringify({ type, data: stampLog(type, data) });
    for (const [res] of clients) send(res, msg);
  }

  /** Broadcast to a specific user's clients only */
  function broadcastTo(userId: string, type: string, data: unknown) {
    const msg = JSON.stringify({ type, data: stampLog(type, data) });
    if (!SKIP_HISTORY.has(type)) {
      const history = getUserHistory(userId);
      history.push(msg);
      if (history.length > MAX_LOG_HISTORY)
        history.splice(0, history.length - MAX_LOG_HISTORY);
    }
    for (const [res, uid] of clients) {
      if (uid === userId) send(res, msg);
    }
  }

  function addClient(
    res: Response,
    userId: string | null,
    currentTask: string | null,
    searchedArtists: ReadonlySet<string>,
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
    // Send user-specific history
    if (userId) {
      const history = logHistory.get(userId);
      if (history) {
        for (const msg of history) send(res, msg);
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

// ── Declarative event → broadcast wiring ─────────────────────────────────────

type BroadcastSpec<Args extends unknown[]> =
  | { type: string; pack: (...args: Args) => unknown }
  | { log: (...args: Args) => string; level?: string };

export type BroadcastMapping<T extends EventMap> = {
  [K in keyof T & string]?: BroadcastSpec<T[K]>;
};

/**
 * Build an EventHandlers object that broadcasts each event.
 * Each mapping entry either sends a typed WS message (`type` + `pack`)
 * or sends a `log` message (`log` + optional `level`).
 */
export function broadcastEvents<T extends EventMap>(
  broadcast: (type: string, data: unknown) => void,
  mapping: BroadcastMapping<T>,
): EventHandlers<T> {
  const handlers: Record<string, (...args: unknown[]) => void> = {};

  for (const [event, spec] of Object.entries(mapping)) {
    if (!spec) continue;
    const handlerName = `on${event[0].toUpperCase()}${event.slice(1)}`;
    handlers[handlerName] = (...args: unknown[]) => {
      if ('type' in spec) {
        broadcast(
          (spec as { type: string; pack: (...a: unknown[]) => unknown }).type,
          (spec as { type: string; pack: (...a: unknown[]) => unknown }).pack(
            ...args,
          ),
        );
      } else {
        const s = spec as { log: (...a: unknown[]) => string; level?: string };
        broadcast('log', { level: s.level ?? 'info', message: s.log(...args) });
      }
    };
  }

  return handlers as unknown as EventHandlers<T>;
}
