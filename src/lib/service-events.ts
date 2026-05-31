// ── Event system infrastructure ──────────────────────────────────────────────

/** Record from event name to argument tuple. */
export type EventMap = Record<string, unknown[]>;

/** Derives `{ onFoo?: (...args) => void }` from `{ foo: [...args] }`. */
export type EventHandlers<T extends EventMap> = {
  [K in keyof T & string as `on${Capitalize<K>}`]?: (...args: T[K]) => void;
};

/** Typed emitter — wraps an optional handlers object and provides `emit`. */
export class ServiceEmitter<T extends EventMap> {
  private handlers: EventHandlers<T>;

  constructor(handlers?: EventHandlers<T>) {
    this.handlers = handlers ?? ({} as EventHandlers<T>);
  }

  emit<K extends keyof T & string>(event: K, ...args: T[K]): void {
    const key =
      `on${event[0].toUpperCase()}${event.slice(1)}` as keyof EventHandlers<T>;
    const handler = this.handlers[key] as ((...a: T[K]) => void) | undefined;
    handler?.(...args);
  }
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
 * Each mapping entry either sends a typed message (`type` + `pack`)
 * or sends a `log` message (`log` + optional `level`).
 *
 * Lives in `lib/` (not `web/`) because it has no web dependency —
 * the `broadcast` callback is just `(type, data) => void`.
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
