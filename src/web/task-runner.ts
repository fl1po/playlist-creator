import type express from 'express';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { ApiCallOptions, SpotifyClient } from '../lib/types.js';
import type { UserConfigStore } from '../lib/user-config.js';
import type { Broadcaster } from './broadcast.js';
import type { RouteContext, UserSession } from './route-context.js';
import type { TaskMutex } from './task-mutex.js';

export interface TaskContext {
  /** Abort-wrapped Spotify client. */
  client: SpotifyClient;
  /** SpotifyContext with pacer and optional API callbacks. */
  ctx: SpotifyContext;
  /** Parsed request body. */
  body: Record<string, unknown>;
  /** User's config store. */
  userConfigStore: UserConfigStore;
  /** User's data directory path. */
  dataDir: string;
  /** User ID. */
  userId: string;
  /** Send a typed WebSocket message to all clients. */
  broadcast: (type: string, data: unknown) => void;
  /** Throws if the user requested abort. */
  checkAbort: () => void;
  /** Shared request pacer. */
  pacer: RequestPacer;
  /** Un-wrapped client for post-task work (e.g. sync). */
  rawClient: SpotifyClient;
}

export interface TaskDefinition {
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
  /** The task body. */
  run: (tc: TaskContext) => Promise<void>;
  /** Always runs after task (success, failure, or abort). */
  cleanup?: (tc: TaskContext) => void | Promise<void>;
  /** Custom error handler for task-specific error broadcasts. Called before the generic log. */
  onError?: (tc: TaskContext, error: unknown, aborted: boolean) => void;
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
  const broadcast = broadcaster.broadcast;

  return {
    register(def: TaskDefinition) {
      const method = def.method ?? 'post';
      app[method](`/api${def.path}`, (req: express.Request, res: express.Response) => {
        const session = routeCtx.requireSession(req, res);
        if (!session) return;

        if (def.validate) {
          const err = def.validate((req.body as Record<string, unknown>) ?? {});
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

        const abortableClient = taskMutex.createAbortableClient(session.client);
        const apiCallbacks = def.apiCallbacks?.(broadcast);
        const ctx = createSpotifyContext(abortableClient, apiCallbacks, pacer);

        const tc: TaskContext = {
          client: abortableClient,
          ctx,
          body: (req.body as Record<string, unknown>) ?? {},
          userConfigStore: session.userConfigStore,
          dataDir: session.dataDir,
          userId: session.userId,
          broadcast,
          checkAbort: () => taskMutex.checkAbort(),
          pacer,
          rawClient: session.client,
        };

        res.json({
          ok: true,
          message: def.startMessage ?? `${def.name} started`,
        });

        def
          .run(tc)
          .catch((err) => {
            def.onError?.(tc, err, abort.aborted);
            if (abort.aborted) {
              broadcast('log', {
                level: 'warn',
                message: `${def.name} stopped by user`,
              });
            } else {
              broadcast('log', {
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
      });
    },
  };
}
