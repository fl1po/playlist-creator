import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type express from 'express';
import { describeSpotifyEvent } from '../lib/spotify/events.js';
import { type SpotifyGateway, TaskAborted } from '../lib/spotify/gateway.js';
import type {
  ProgressUpdate,
  ProgressView,
  TaskProgress,
} from '../lib/task-progress.js';
import type { UserConfig } from '../lib/user-config.js';
import type { UserData } from '../lib/user-data/index.js';
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
}

export type TypedEmit<E extends BroadcastEventMap> = <
  K extends keyof E & string,
>(
  type: K,
  data: E[K],
) => void;

type UserProfile = Awaited<ReturnType<SpotifyApi['currentUser']['profile']>>;

export interface TaskContext<E extends BaseEvents = BaseEvents> {
  /**
   * The owner's Spotify gateway on the background lane. Stopping the task
   * aborts its calls and waits; rate-limit waits are logged to the owner.
   */
  ctx: SpotifyGateway;
  body: Record<string, unknown>;
  userId: string;
  /** Throws `TaskAborted` if the user requested abort. */
  checkAbort: () => void;
  /** Where the task is, shown to its owner only (ADR-0006). */
  progress: TaskProgress;
  /** The owner's user data. */
  data: UserData;
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
  run: (tc: TaskContext<E>) => Promise<void>;
  /** Always runs after task (success, failure, or abort). */
  cleanup?: (tc: TaskContext<E>) => void | Promise<void>;
  /** Custom error handler for task-specific error broadcasts. Called before the generic log. */
  onError?: (tc: TaskContext<E>, error: unknown, aborted: boolean) => void;
  /** Message sent in the immediate HTTP response. */
  startMessage?: string;
}

export { TaskAborted };

/** What one viewer may know about the server's task slot (ADR-0003). */
export type TaskStatus =
  | { busy: false; mine: false }
  | { busy: true; mine: false }
  | {
      busy: true;
      mine: true;
      task: string;
      stopping: boolean;
      /** Present once the task has reported any progress. */
      progress?: ProgressView;
    };

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
}

interface Running {
  name: string;
  userId: string;
  abort: AbortController;
  progress: ProgressState | null;
}

interface ProgressState {
  steps: ProgressView['steps'];
  bars: Map<string, ProgressView['bars'][number]>;
  marked: Set<string>;
  waitUntil?: number;
  /** Marked since the last live update. */
  added: string[];
  sendQueued: boolean;
}

function viewOf(p: ProgressState): ProgressView {
  return {
    steps: p.steps.map((s) => ({ ...s })),
    bars: [...p.bars.values()].map((b) => ({ ...b })),
    marked: [...p.marked],
    ...(p.waitUntil !== undefined && { waitUntil: p.waitUntil }),
  };
}

/**
 * Runs at most one task at a time across the server (ADR-0003). The user who
 * started it owns it: only they can stop it or learn what it is. Every
 * message the task sends is tagged with its name and goes to its owner only.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { broadcaster } = deps;
  let running: Running | null = null;

  function statusFor(userId: string | null): TaskStatus {
    if (!running) return { busy: false, mine: false };
    if (running.userId !== userId) return { busy: true, mine: false };
    return {
      busy: true,
      mine: true,
      task: running.name,
      stopping: running.abort.signal.aborted,
      ...(running.progress && { progress: viewOf(running.progress) }),
    };
  }

  /**
   * The run's progress record. Everything reported in one turn goes to the
   * owner as one live update, and nothing is sent once the run has ended.
   */
  function progressOf(run: Running) {
    const state = (): ProgressState => {
      run.progress ??= {
        steps: [],
        bars: new Map(),
        marked: new Set(),
        added: [],
        sendQueued: false,
      };
      return run.progress;
    };
    const send = (p: ProgressState) => {
      if (p.sendQueued) return;
      p.sendQueued = true;
      queueMicrotask(() => {
        p.sendQueued = false;
        if (running !== run) return;
        const { marked: _all, ...rest } = viewOf(p);
        const update: ProgressUpdate = { ...rest, markedAdded: p.added };
        p.added = [];
        broadcaster.broadcastTo(run.userId, 'status', {
          ...statusFor(run.userId),
          progress: update,
        });
      });
    };
    /** Any report means the task moved on from a rate-limit wait. */
    const report = (change: (p: ProgressState) => void) => {
      const p = state();
      p.waitUntil = undefined;
      change(p);
      send(p);
    };

    const progress: TaskProgress = {
      steps: (labels) =>
        report((p) => {
          p.steps = labels.map((label) => ({ label, state: 'pending' }));
        }),
      step: (index, stepState) =>
        report((p) => {
          if (p.steps[index]) p.steps[index].state = stepState;
        }),
      bar: (key, value, total, text) =>
        report((p) => {
          p.bars.set(key, { key, value, total, text });
        }),
      clearBar: (key) =>
        report((p) => {
          p.bars.delete(key);
        }),
      mark: (...names) =>
        report((p) => {
          for (const name of names) {
            if (p.marked.has(name)) continue;
            p.marked.add(name);
            p.added.push(name);
          }
        }),
    };
    const waitUntil = (until: number) => {
      const p = state();
      p.waitUntil = until;
      send(p);
    };
    return { progress, waitUntil };
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

    // Bound to this task's own signal: work leaking past the task's end must
    // keep honouring this task's stop, never a later task's.
    const abort = new AbortController();
    const run: Running = {
      name: def.name,
      userId: session.userId,
      abort,
      progress: null,
    };
    running = run;
    publishStatus();

    const tc = createTaskContext(def, session, body, run);
    const done = (async () => {
      try {
        await def.run(tc);
      } catch (err) {
        const stopped = abort.signal.aborted;
        def.onError?.(tc, err, stopped);
        if (stopped) tc.log('warn', `${def.name} stopped by user`);
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
    if (running.abort.signal.aborted) return 'already-stopping';
    running.abort.abort(new TaskAborted());
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
    run: Running,
  ): TaskContext<E> {
    const { signal } = run.abort;
    const checkAbort = () => signal.throwIfAborted();
    const userBroadcast = (type: string, data: unknown) =>
      broadcaster.broadcastTo(session.userId, type, data, def.name);
    const { progress, waitUntil } = progressOf(run);
    const ctx = session.gateway.forTask({
      signal,
      onEvent: (event) => {
        userBroadcast('log', describeSpotifyEvent(event));
        // Rate-limit waits drive the owner's countdown.
        if (event.type === 'rateLimitWait' || event.type === 'longSleep') {
          waitUntil(event.until.getTime());
        }
      },
    });

    let userConfigPromise: Promise<UserConfig> | undefined;
    let mePromise: Promise<UserProfile> | undefined;

    return {
      ctx,
      body,
      userId: session.userId,
      checkAbort,
      progress,
      data: session.data,
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
        userConfigPromise ??= session.data.config.load();
        return userConfigPromise;
      },
      me: () => {
        mePromise ??= ctx
          .call((api) => api.currentUser.profile(), 'user profile')
          .then((r) => {
            if (!r.success) throw r.error;
            return r.data;
          });
        return mePromise;
      },
    };
  }

  return { start, stop, statusFor };
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
