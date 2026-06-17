import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { ApiCallOptions, SpotifyClient } from '../lib/types.js';
import type { IUserConfigStore, UserConfig } from '../lib/user-config.js';
import type { RouteContext } from './route-context.js';

/** Map from broadcast event name to payload type. */
export type BroadcastEventMap = Record<string, unknown>;

/** Events every task gets without declaring them. */
export interface BaseEvents extends BroadcastEventMap {
  log: {
    level: 'info' | 'warn' | 'error' | 'success' | 'debug';
    message: string;
  };
  'data:save': { key: string; value: unknown };
}

/** Typed broadcast emitter. */
export type TypedEmit<E extends BroadcastEventMap> = <
  K extends keyof E & string,
>(
  type: K,
  data: E[K],
) => void;

/** Spotify user profile, derived from the SDK without importing it directly. */
type UserProfile = Awaited<
  ReturnType<SpotifyClient['api']['currentUser']['profile']>
>;

export interface TaskContext<
  E extends BaseEvents = BaseEvents,
  C extends string = string,
> {
  /** Abort-wrapped Spotify client. */
  client: SpotifyClient;
  /** SpotifyContext with pacer and optional API callbacks. */
  ctx: SpotifyContext;
  /** Parsed request body. */
  body: Record<string, unknown>;
  /** User's config store. */
  userConfigStore: IUserConfigStore;
  /** User's data directory path. */
  dataDir: string;
  /** User ID. */
  userId: string;
  /**
   * Untyped broadcast — interop escape hatch for helpers that take a generic
   * `(type, data) => void` (e.g. `broadcastEvents`, `broadcastHandlers`,
   * `broadcastApiCallbacks`, `syncIfNeeded`). For direct task emissions use
   * `emit`, `log`, or `emitData`.
   */
  broadcast: (type: string, data: unknown) => void;
  /** Throws if the user requested abort. */
  checkAbort: () => void;
  /** Shared request pacer. */
  pacer: RequestPacer;
  /** Client-provided caches (from request body), keyed by declared cache names. */
  caches: { [K in C]: unknown };
  /**
   * Emit data back to client for localStorage persistence.
   * Sugar for `emit('data:save', { key, value })`.
   */
  emitData: (key: string, value: unknown) => void;
  /** Typed broadcast — only declared event names + payloads compile. */
  emit: TypedEmit<E>;
  /** Sugar for `emit('log', { level, message })`. */
  log: (
    level: 'info' | 'warn' | 'error' | 'success' | 'debug',
    message: string,
  ) => void;
  /**
   * Iterate with `checkAbort()` injected before each item. Replaces the
   * `for (...) { tc.checkAbort(); ... }` rhythm scattered through tasks.
   */
  iter: <T>(
    items: Iterable<T>,
    fn: (item: T, index: number) => Promise<void> | void,
  ) => Promise<void>;
  /** Memoised user config — first call awaits load(); subsequent calls reuse. */
  userConfig: () => Promise<UserConfig>;
  /** Memoised current-user profile — first call hits Spotify; subsequent calls reuse. */
  me: () => Promise<UserProfile>;
}

/**
 * Declarative binding from a client-provided cache field on `body.caches` to
 * a file inside the user's data directory. The runner hydrates each binding
 * before `run()` so tasks don't write the same `fs.mkdirSync` + `writeFileSync`
 * pair inline.
 */
export interface CacheBinding<K extends string = string> {
  /** Field name on `body.caches`. */
  key: K;
  /** Filename inside `dataDir` to write the cache to (JSON-stringified). */
  file: string;
}

export interface TaskDefinition<
  E extends BaseEvents = BaseEvents,
  C extends string = string,
> {
  /** Task name shown in status broadcasts (e.g. "fill"). */
  name: string;
  /** API route path (e.g. "/fill"). Mounted under /api. */
  path: string;
  /** HTTP method. Defaults to "post". */
  method?: 'get' | 'post';
  /** Validate request body before mutex acquisition. Return error string to reject. */
  validate?: (body: Record<string, unknown>) => string | undefined;
  /** Factory for API call callbacks (rate limit, network retry, etc.). */
  apiCallbacks?: (
    broadcast: (type: string, data: unknown) => void,
  ) => ApiCallOptions;
  /**
   * Cache fields on `body.caches` to hydrate to disk before `run()`.
   * Each present cache is written to `dataDir/<file>` as JSON.
   */
  caches?: ReadonlyArray<CacheBinding<C>>;
  /** The task body. */
  run: (tc: TaskContext<E, C>) => Promise<void>;
  /** Always runs after task (success, failure, or abort). */
  cleanup?: (tc: TaskContext<E, C>) => void | Promise<void>;
  /** Custom error handler for task-specific error broadcasts. Called before the generic log. */
  onError?: (tc: TaskContext<E, C>, error: unknown, aborted: boolean) => void;
  /** Message sent in the immediate HTTP response. */
  startMessage?: string;
}

export interface TaskRunnerDeps {
  app: express.Express;
  routeCtx: RouteContext;
}

export function createTaskRunner(deps: TaskRunnerDeps) {
  const { app, routeCtx } = deps;
  const { taskMutex, broadcaster, pacer } = routeCtx;

  return {
    register<E extends BaseEvents = BaseEvents, C extends string = string>(
      def: TaskDefinition<E, C>,
    ) {
      const method = def.method ?? 'post';
      app[method](
        `/api${def.path}`,
        (req: express.Request, res: express.Response) => {
          const session = routeCtx.requireSession(req, res);
          if (!session) return;

          if (def.validate) {
            const err = def.validate(
              (req.body as Record<string, unknown>) ?? {},
            );
            if (err) {
              res.status(400).json({ error: err });
              return;
            }
          }

          const abort = taskMutex.setBusy(def.name, session.userId);
          if (!abort) {
            res
              .status(409)
              .json({ error: `Busy: "${taskMutex.currentTask}" is running` });
            return;
          }

          const abortableClient = taskMutex.createAbortableClient(
            session.client,
          );
          const userBroadcast = (type: string, data: unknown) =>
            broadcaster.broadcastTo(session.userId, type, data);
          const apiCallbacks = def.apiCallbacks?.(userBroadcast);
          const ctx = createSpotifyContext(
            abortableClient,
            apiCallbacks,
            pacer,
          );

          const body = (req.body as Record<string, unknown>) ?? {};

          let userConfigPromise: Promise<UserConfig> | undefined;
          let mePromise: Promise<UserProfile> | undefined;
          const checkAbort = () => taskMutex.checkAbort();

          const tc: TaskContext<E, C> = {
            client: abortableClient,
            ctx,
            body,
            userConfigStore: session.userConfigStore,
            dataDir: session.dataDir,
            userId: session.userId,
            broadcast: userBroadcast,
            checkAbort,
            pacer,
            caches: ((body.caches as Record<string, unknown>) ??
              {}) as TaskContext<E, C>['caches'],
            emitData: (key, value) => {
              userBroadcast('data:save', { key, value });
            },
            emit: userBroadcast as TypedEmit<E>,
            log: (level, message) => {
              userBroadcast('log', { level, message });
            },
            iter: async (items, fn) => {
              let i = 0;
              for (const item of items) {
                checkAbort();
                await fn(item, i++);
              }
            },
            userConfig: () => {
              userConfigPromise ??= Promise.resolve(
                session.userConfigStore.load(),
              );
              return userConfigPromise;
            },
            me: () => {
              mePromise ??= abortableClient.api.currentUser.profile();
              return mePromise;
            },
          };

          res.json({
            ok: true,
            message: def.startMessage ?? `${def.name} started`,
          });

          const hydrateAndRun = async () => {
            // Every task assumes its data dir exists (services write cache files
            // into it). The client no longer hydrates caches, so the old
            // mkdir-on-hydrate path may not run — create it unconditionally.
            fs.mkdirSync(session.dataDir, { recursive: true });
            if (def.caches) {
              for (const binding of def.caches) {
                const value = tc.caches[binding.key];
                if (value === undefined) continue;
                fs.writeFileSync(
                  path.join(session.dataDir, binding.file),
                  JSON.stringify(value, null, 2),
                );
              }
            }
            await def.run(tc);
          };

          hydrateAndRun()
            .catch((err) => {
              def.onError?.(tc, err, abort.aborted);
              if (abort.aborted) {
                userBroadcast('log', {
                  level: 'warn',
                  message: `${def.name} stopped by user`,
                });
              } else {
                userBroadcast('log', {
                  level: 'error',
                  message: `${def.name} failed: ${err}`,
                });
              }
            })
            .finally(async () => {
              try {
                await def.cleanup?.(tc);
              } catch {
                /* swallow cleanup errors */
              }
              taskMutex.setIdle();
            });
        },
      );
    },
  };
}
