import type { Response } from 'express';
import type { EventMap, EventHandlers } from '../lib/service-events.js';

export interface Broadcaster {
  broadcast(type: string, data: unknown): void;
  addClient(
    res: Response,
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
  const clients = new Set<Response>();
  const logHistory: string[] = [];

  function send(res: Response, msg: string) {
    if (!res.writableEnded) res.write(`data: ${msg}\n\n`);
  }

  function broadcast(type: string, data: unknown) {
    const msg = JSON.stringify({ type, data });
    if (!SKIP_HISTORY.has(type)) {
      logHistory.push(msg);
      if (logHistory.length > MAX_LOG_HISTORY)
        logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
    }
    for (const res of clients) send(res, msg);
  }

  function addClient(
    res: Response,
    currentTask: string | null,
    searchedArtists: ReadonlySet<string>,
  ) {
    clients.add(res);
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
    for (const msg of logHistory) send(res, msg);
    res.on('close', () => clients.delete(res));
  }

  function removeClient(res: Response) {
    clients.delete(res);
  }

  function clearHistory() {
    logHistory.length = 0;
  }

  return { broadcast, addClient, removeClient, clearHistory };
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
