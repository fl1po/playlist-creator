import fs from 'node:fs';
import type express from 'express';
import { createDurableCache } from '../lib/durable-cache.js';
import type { DurableCache } from '../lib/durable-cache.js';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { ApiCallOptions, SpotifyClient } from '../lib/types.js';
import type { IUserConfigStore, UserConfig } from '../lib/user-config.js';
import type { Broadcaster } from './broadcast.js';
import type { UserSession } from './route-context.js';

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

export interface TaskContext<E extends BaseEvents = BaseEvents> {
  /** Abort-wrapped Spotify client. */
  client: SpotifyClient;
  /** SpotifyContext with pacer and optional API callbacks. */
  ctx: SpotifyContext;
  body: Record<string, unknown>;
  userConfigStore: IUserConfigStore;
  dataDir: string;
  userId: string;
  /**
   * Untyped broadcast — interop escape hatch for helpers that take a generic
   * `(type, data) => void` (e.g. `broadcastEvents`, `broadcastHandlers`,
   * `broadcastApiCallbacks`, the sync handlers). For direct task emissions
   * use `emit` or `log`.
   */
  broadcast: (type: string, data: unknown) => void;
  /** Throws if the user requested abort. */
  checkAbort: () => void;
  pacer: RequestPacer;
  /**
   * File-then-Redis durable cache, scoped to this user. Every save is also
   * mirrored to the browser's localStorage.
   */
  cache: DurableCache;
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

export interface TaskDefinition<E extends BaseEvents = BaseEvents> {
  /** Task name shown in status broadcasts (e.g. "fill"). */
  name: string;
  /** API route path (e.g. "/fill"). Mounted under /api. */
  path: string;
  /** HTTP method. Defaults to "post". */
  method?: 'get' | 'post';
  /** Validate request body before the task slot is taken. Return error string to reject. */
  validate?: (body: Record<string, unknown>) => string | undefined;
  /** Factory for API call callbacks (rate limit, network retry, etc.). */
  apiCallbacks?: (
    broadcast: (type: string, data: unknown) => void,
  ) => ApiCallOptions;
  run: (tc: TaskContext<E>) => Promise<void>;
  /** Always runs after task (success, failure, or abort). */
  cleanup?: (tc: TaskContext<E>) => void | Promise<void>;
  /** Custom error handler for task-specific error broadcasts. Called before the generic log. */
  onError?: (tc: TaskContext<E>, error: unknown, aborted: boolean) => void;
  /** Message sent in the immediate HTTP response. */
  startMessage?: string;
}

/**
 * Thrown by `checkAbort` and the abortable client once the owner stops the
 * task. The message stays "Stopped by user": api-wrapper and fill-run match on
 * it to tell a stop from a failure.
 */
export class TaskAborted extends Error {
  constructor() {
    super('Stopped by user');
    this.name = 'TaskAborted';
  }
}

/** What one viewer may know about the server's task slot (ADR-0003). */
export type TaskStatus =
  | { busy: false; mine: false }
  | { busy: true; mine: false }
  | { busy: true; mine: true; task: string; stopping: boolean };

export type StartResult =
  /** `done` settles once run, error handling and cleanup are all over; it never rejects. */
  | { kind: 'started'; done: Promise<void> }
  /** `task` is only named to the user who owns it. */
  | { kind: 'busy'; task?: string }
  | { kind: 'invalid'; error: string };

export type StopResult = 'stopping' | 'already-stopping' | 'none' | 'not-owner';

export interface TaskRunner {
  /** Take the server's one task slot and run `def` in the background. */
  start<E extends BaseEvents>(
    def: TaskDefinition<E>,
    session: UserSession,
    body: Record<string, unknown>,
  ): StartResult;
  stop(userId: string): StopResult;
  statusFor(userId: string | null): TaskStatus;
}

export interface TaskRunnerDeps {
  broadcaster: Broadcaster;
  pacer: RequestPacer;
}

interface Running {
  name: string;
  userId: string;
  abort: { aborted: boolean };
}

/**
 * Runs at most one task at a time across the server (ADR-0003). The user who
 * started it owns it: only they can stop it or learn what it is. Every
 * message the task sends is tagged with its name and goes to its owner only.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { broadcaster, pacer } = deps;
  let running: Running | null = null;

  function statusFor(userId: string | null): TaskStatus {
    if (!running) return { busy: false, mine: false };
    if (running.userId !== userId) return { busy: true, mine: false };
    return {
      busy: true,
      mine: true,
      task: running.name,
      stopping: running.abort.aborted,
    };
  }

  const publishStatus = () => broadcaster.broadcastEach('status', statusFor);
  broadcaster.onConnect((userId) => [
    { type: 'status', data: statusFor(userId) },
  ]);

  function start<E extends BaseEvents>(
    def: TaskDefinition<E>,
    session: UserSession,
    body: Record<string, unknown>,
  ): StartResult {
    const invalid = def.validate?.(body);
    if (invalid) return { kind: 'invalid', error: invalid };
    if (running) {
      return running.userId === session.userId
        ? { kind: 'busy', task: running.name }
        : { kind: 'busy' };
    }

    // Bound to this task's own flag: work leaking past the task's end must
    // keep honouring this task's stop, never a later task's.
    const abort = { aborted: false };
    running = { name: def.name, userId: session.userId, abort };
    publishStatus();

    const tc = createTaskContext(def, session, body, abort);
    const done = (async () => {
      try {
        // Every task assumes its data dir exists (services write cache files into it).
        fs.mkdirSync(session.dataDir, { recursive: true });
        await def.run(tc);
      } catch (err) {
        def.onError?.(tc, err, abort.aborted);
        if (abort.aborted) tc.log('warn', `${def.name} stopped by user`);
        else tc.log('error', `${def.name} failed: ${err}`);
      } finally {
        try {
          await def.cleanup?.(tc);
        } catch {
          /* swallow cleanup errors */
        }
        running = null;
        publishStatus();
      }
    })();
    return { kind: 'started', done };
  }

  function stop(userId: string): StopResult {
    if (!running) return 'none';
    if (running.userId !== userId) return 'not-owner';
    if (running.abort.aborted) return 'already-stopping';
    running.abort.aborted = true;
    broadcaster.broadcastTo(
      userId,
      'log',
      { level: 'warn', message: `Stopping ${running.name}...` },
      running.name,
    );
    publishStatus();
    return 'stopping';
  }

  function createTaskContext<E extends BaseEvents>(
    def: TaskDefinition<E>,
    session: UserSession,
    body: Record<string, unknown>,
    abort: { aborted: boolean },
  ): TaskContext<E> {
    const checkAbort = () => {
      if (abort.aborted) throw new TaskAborted();
    };
    const client = abortableClient(session, checkAbort);
    const userBroadcast = (type: string, data: unknown) =>
      broadcaster.broadcastTo(session.userId, type, data, def.name);
    const ctx = createSpotifyContext(
      client,
      def.apiCallbacks?.(userBroadcast),
      pacer,
    );

    let userConfigPromise: Promise<UserConfig> | undefined;
    let mePromise: Promise<UserProfile> | undefined;

    return {
      client,
      ctx,
      body,
      userConfigStore: session.userConfigStore,
      dataDir: session.dataDir,
      userId: session.userId,
      broadcast: userBroadcast,
      checkAbort,
      pacer,
      // Mirror every save to the browser's localStorage under the
      // dataset's name.
      cache: createDurableCache({
        userId: session.userId,
        dataDir: session.dataDir,
        onSave: (descriptor, value) =>
          userBroadcast('data:save', { key: descriptor.redisName, value }),
      }),
      emit: userBroadcast as TypedEmit<E>,
      log: (level, message) => userBroadcast('log', { level, message }),
      iter: async (items, fn) => {
        let i = 0;
        for (const item of items) {
          checkAbort();
          await fn(item, i++);
        }
      },
      userConfig: () => {
        userConfigPromise ??= Promise.resolve(session.userConfigStore.load());
        return userConfigPromise;
      },
      me: () => {
        mePromise ??= client.api.currentUser.profile();
        return mePromise;
      },
    };
  }

  return { start, stop, statusFor };
}

/**
 * Reads `session.client` on every access rather than capturing it: token
 * rotation rebuilds the session's client mid-task, and a captured one would
 * keep refreshing with its own copy of the refresh token alongside it.
 */
function abortableClient(
  session: UserSession,
  checkAbort: () => void,
): SpotifyClient {
  return {
    get api() {
      checkAbort();
      return session.client.api;
    },
    refreshToken: () => {
      checkAbort();
      return session.client.refreshToken();
    },
    recreateApi: () => {
      checkAbort();
      return session.client.recreateApi();
    },
    runAuth: (attempt) => session.client.runAuth(attempt),
    setTokens: (tokens) => session.client.setTokens(tokens),
  };
}

// ── Express adapter ─────────────────────────────────────────────────────────

type RequireSession = (
  req: express.Request,
  res: express.Response,
) => UserSession | null;

/** Mount `def` at `/api${def.path}`; the runner decides, this maps to HTTP. */
export function mountTask<E extends BaseEvents>(
  app: express.Express,
  runner: TaskRunner,
  def: TaskDefinition<E>,
  requireSession: RequireSession,
) {
  app[def.method ?? 'post'](`/api${def.path}`, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    const result = runner.start(
      def,
      session,
      (req.body as Record<string, unknown>) ?? {},
    );
    switch (result.kind) {
      case 'invalid':
        res.status(400).json({ error: result.error });
        return;
      case 'busy':
        res.status(409).json({
          error: result.task
            ? `Busy: "${result.task}" is running`
            : 'Busy: another user’s task is running',
        });
        return;
      case 'started':
        res.json({
          ok: true,
          message: def.startMessage ?? `${def.name} started`,
        });
    }
  });
}

/** `/api/stop` and `/api/status`. */
export function mountTaskControls(
  app: express.Express,
  runner: TaskRunner,
  requireSession: RequireSession,
) {
  app.post('/api/stop', (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    switch (runner.stop(session.userId)) {
      case 'none':
        res.status(400).json({ error: 'No task running' });
        return;
      case 'not-owner':
        res.status(403).json({ error: 'Task belongs to another user' });
        return;
      case 'already-stopping':
        res.json({ ok: true, message: 'Already stopping' });
        return;
      case 'stopping':
        res.json({ ok: true, message: 'Stopping' });
    }
  });

  app.get('/api/status', (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(runner.statusFor(session.userId));
  });
}
