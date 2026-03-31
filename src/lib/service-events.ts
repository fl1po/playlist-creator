// ── Event system infrastructure ──────────────────────────────────────────────

/** Record from event name to argument tuple. */
export type EventMap = Record<string, unknown[]>;

/** Derives `{ onFoo?: (...args) => void }` from `{ foo: [...args] }`. */
export type EventHandlers<T extends EventMap> = {
  [K in keyof T & string as `on${Capitalize<K>}`]?: (
    ...args: T[K]
  ) => void;
};

/** Typed emitter — wraps an optional handlers object and provides `emit`. */
export class ServiceEmitter<T extends EventMap> {
  private handlers: EventHandlers<T>;

  constructor(handlers?: EventHandlers<T>) {
    this.handlers = handlers ?? ({} as EventHandlers<T>);
  }

  emit<K extends keyof T & string>(event: K, ...args: T[K]): void {
    const key = `on${event[0].toUpperCase()}${event.slice(1)}` as keyof EventHandlers<T>;
    const handler = this.handlers[key] as
      | ((...a: T[K]) => void)
      | undefined;
    handler?.(...args);
  }
}
