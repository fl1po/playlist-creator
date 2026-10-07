import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Response } from 'express';
import { RequestPacer } from '../lib/request-pacer.js';
import type { SpotifyClient } from '../lib/types.js';
import type { IUserConfigStore } from '../lib/user-config.js';
import { createBroadcaster } from '../web/broadcast.js';
import type { UserSession } from '../web/route-context.js';
import {
  type TaskContext,
  type TaskDefinition,
  createTaskRunner,
} from '../web/task-runner.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Message {
  type: string;
  data: Record<string, unknown>;
  task?: string;
}

function fakeClient() {
  const frames: string[] = [];
  const res = {
    writableEnded: false,
    write(chunk: string) {
      frames.push(chunk);
      return true;
    },
    on() {
      return this;
    },
  } as unknown as Response;
  const messages = (): Message[] =>
    frames
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
  return {
    res,
    messages,
    statuses: () =>
      messages()
        .filter((m) => m.type === 'status')
        .map((m) => m.data),
    lastStatus: () => {
      const s = messages().filter((m) => m.type === 'status');
      return s[s.length - 1]?.data;
    },
  };
}

/** A Spotify client whose `api` records which client instance served it. */
function fakeSpotify(label: string): SpotifyClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get api() {
      calls.push(label);
      return { label } as unknown as SpotifyClient['api'];
    },
    refreshToken: async () => label,
    recreateApi: async () => ({ label }) as unknown as SpotifyClient['api'],
    runAuth: async () => true,
    setTokens: () => {},
  };
}

function session(userId: string, client = fakeSpotify(userId)): UserSession {
  return {
    userId,
    client,
    userConfigStore: {} as IUserConfigStore,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `task-runner-${userId}-`)),
  };
}

/** A task whose `run` waits until the test releases it. */
function gatedTask(
  name: string,
  extra: Partial<TaskDefinition> = {},
): TaskDefinition & {
  release: () => void;
  fail: (err: unknown) => void;
  started: Promise<TaskContext>;
} {
  let release!: () => void;
  let fail!: (err: unknown) => void;
  let markStarted!: (tc: TaskContext) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const started = new Promise<TaskContext>((r) => {
    markStarted = r;
  });
  return {
    name,
    path: `/${name}`,
    async run(tc) {
      markStarted(tc);
      await gate;
    },
    ...extra,
    release,
    fail,
    started,
  };
}

function setup() {
  const broadcaster = createBroadcaster();
  const runner = createTaskRunner({
    broadcaster,
    pacer: new RequestPacer(1000),
  });
  const connect = (userId: string | null) => {
    const c = fakeClient();
    broadcaster.addClient(c.res, userId);
    return c;
  };
  return { broadcaster, runner, connect };
}

function started(
  result: ReturnType<ReturnType<typeof createTaskRunner>['start']>,
) {
  assert.equal(result.kind, 'started');
  return result as Extract<typeof result, { kind: 'started' }>;
}

// ── Busy ─────────────────────────────────────────────────────────────────────

test('a second task is refused while one runs, for any user', async () => {
  const { runner } = setup();
  const fill = gatedTask('fill');
  const run = started(runner.start(fill, session('u1'), {}));

  const own = runner.start(gatedTask('recalculate'), session('u1'), {});
  assert.deepEqual(own, { kind: 'busy', task: 'fill' });

  // Another user learns the server is busy, not what is running.
  const other = runner.start(gatedTask('recalculate'), session('u2'), {});
  assert.deepEqual(other, { kind: 'busy' });

  fill.release();
  await run.done;
  started(runner.start(gatedTask('recalculate'), session('u2'), {}));
});

test('validation failures are reported before the slot is taken', () => {
  const { runner } = setup();
  const task = gatedTask('clear', {
    validate: (body) => (body.name ? undefined : 'name is required'),
  });
  assert.deepEqual(runner.start(task, session('u1'), {}), {
    kind: 'invalid',
    error: 'name is required',
  });
  assert.deepEqual(runner.statusFor('u1'), { busy: false, mine: false });
});

// ── Ownership ────────────────────────────────────────────────────────────────

test('only the owner can stop a task', async () => {
  const { runner } = setup();
  assert.equal(runner.stop('u1'), 'none');

  const fill = gatedTask('fill');
  const run = started(runner.start(fill, session('u1'), {}));
  assert.equal(runner.stop('u2'), 'not-owner');
  assert.equal(runner.stop('u1'), 'stopping');
  assert.equal(runner.stop('u1'), 'already-stopping');

  fill.release();
  await run.done;
  assert.equal(runner.stop('u1'), 'none');
});

// ── Status per viewer ────────────────────────────────────────────────────────

test('each viewer sees the status meant for them, live and on connect', async () => {
  const { runner, connect } = setup();
  const owner = connect('u1');
  const other = connect('u2');
  const anon = connect(null);
  assert.deepEqual(owner.lastStatus(), { busy: false, mine: false });

  const fill = gatedTask('fill');
  const run = started(runner.start(fill, session('u1'), {}));

  const ownerView = { busy: true, mine: true, task: 'fill', stopping: false };
  const outsiderView = { busy: true, mine: false };
  assert.deepEqual(owner.lastStatus(), ownerView);
  assert.deepEqual(other.lastStatus(), outsiderView);
  assert.deepEqual(anon.lastStatus(), outsiderView);

  // Late joiners get the same per-viewer snapshot.
  assert.deepEqual(connect('u1').lastStatus(), ownerView);
  assert.deepEqual(connect('u2').lastStatus(), outsiderView);
  assert.deepEqual(runner.statusFor('u2'), outsiderView);

  fill.release();
  await run.done;
  for (const c of [owner, other, anon]) {
    assert.deepEqual(c.lastStatus(), { busy: false, mine: false });
  }
});

// ── Stopping ─────────────────────────────────────────────────────────────────

test('stopping is visible and the slot frees only after cleanup', async () => {
  const { runner, connect } = setup();
  const owner = connect('u1');
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((r) => {
    releaseCleanup = r;
  });
  const fill = gatedTask('fill', { cleanup: () => cleanupGate });
  const run = started(runner.start(fill, session('u1'), {}));
  const tc = await fill.started;

  runner.stop('u1');
  assert.deepEqual(owner.lastStatus(), {
    busy: true,
    mine: true,
    task: 'fill',
    stopping: true,
  });

  // The task notices the stop at its next check and unwinds…
  assert.throws(() => tc.checkAbort(), { name: 'TaskAborted' });
  fill.release();
  await new Promise((r) => setImmediate(r));
  // …but cleanup still holds the slot.
  assert.equal(runner.statusFor('u1').busy, true);
  assert.equal(runner.start(gatedTask('x'), session('u2'), {}).kind, 'busy');

  releaseCleanup();
  await run.done;
  assert.deepEqual(owner.lastStatus(), { busy: false, mine: false });
});

// ── Abort stays put ──────────────────────────────────────────────────────────

test('a stopped task stays stopped, even through a client leaked past its end', async () => {
  const { runner } = setup();
  const first = gatedTask('fill');
  const firstRun = started(runner.start(first, session('u1'), {}));
  const leaked = (await first.started).client;

  runner.stop('u1');
  first.release();
  await firstRun.done;
  assert.throws(() => leaked.api, { name: 'TaskAborted' });
  assert.throws(() => leaked.refreshToken(), { name: 'TaskAborted' });

  // A later task's client is unaffected by the earlier stop…
  const second = gatedTask('fill');
  const secondRun = started(runner.start(second, session('u1'), {}));
  const fresh = (await second.started).client;
  assert.doesNotThrow(() => fresh.api);
  second.release();
  await secondRun.done;
});

test('an unstopped task’s leaked client is not stopped by a later task’s stop', async () => {
  const { runner } = setup();
  const first = gatedTask('fill');
  const firstRun = started(runner.start(first, session('u1'), {}));
  const leaked = (await first.started).client;
  first.release();
  await firstRun.done;

  const second = gatedTask('fill');
  const secondRun = started(runner.start(second, session('u1'), {}));
  runner.stop('u1');
  assert.doesNotThrow(() => leaked.api);
  second.release();
  await secondRun.done;
});

// ── Client follows the session ───────────────────────────────────────────────

test('a running task follows the session to a rebuilt Spotify client', async () => {
  const { runner } = setup();
  const s = session('u1', fakeSpotify('old'));
  const fill = gatedTask('fill');
  const run = started(runner.start(fill, s, {}));
  const tc = await fill.started;

  tc.client.api;
  const rebuilt = fakeSpotify('new');
  s.client = rebuilt; // token rotation rebuilds the session's client
  tc.client.api;

  assert.deepEqual(rebuilt.calls, ['new']);
  assert.equal(await tc.client.refreshToken(), 'new');
  fill.release();
  await run.done;
});

// ── Outcome logging ──────────────────────────────────────────────────────────

function logs(c: ReturnType<typeof fakeClient>) {
  return c
    .messages()
    .filter((m) => m.type === 'log')
    .map((m) => `${m.data.level}: ${m.data.message}`);
}

test('a failure is logged after the task’s own error handler', async () => {
  const { runner, connect } = setup();
  const owner = connect('u1');
  const seen: string[] = [];
  const fill = gatedTask('fill', {
    onError: (tc, err, aborted) => {
      seen.push(`onError ${String(err)} aborted=${aborted}`);
      tc.log('info', 'task-specific');
    },
  });
  const run = started(runner.start(fill, session('u1'), {}));
  fill.fail(new Error('boom'));
  await run.done;

  assert.deepEqual(seen, ['onError Error: boom aborted=false']);
  assert.deepEqual(logs(owner), [
    'info: task-specific',
    'error: fill failed: Error: boom',
  ]);
});

test('a stop is logged as a stop, not a failure', async () => {
  const { runner, connect } = setup();
  const owner = connect('u1');
  const fill = gatedTask('fill');
  const run = started(runner.start(fill, session('u1'), {}));
  const tc = await fill.started;

  runner.stop('u1');
  try {
    tc.checkAbort();
  } catch (err) {
    fill.fail(err);
  }
  await run.done;
  assert.deepEqual(logs(owner), [
    'warn: Stopping fill...',
    'warn: fill stopped by user',
  ]);
});

test('a throwing cleanup still frees the slot', async () => {
  const { runner } = setup();
  const fill = gatedTask('fill', {
    cleanup: () => {
      throw new Error('cleanup broke');
    },
  });
  const run = started(runner.start(fill, session('u1'), {}));
  fill.release();
  await run.done;
  assert.deepEqual(runner.statusFor('u1'), { busy: false, mine: false });
});

// ── Tagging ──────────────────────────────────────────────────────────────────

test('everything a task sends is tagged with its name and reaches only its owner', async () => {
  const { runner, connect } = setup();
  const owner = connect('u1');
  const other = connect('u2');
  const task: TaskDefinition = {
    name: 'dedup-scan',
    path: '/dedup-scan',
    async run(tc) {
      tc.log('info', 'hello');
      tc.emit('log', { level: 'info', message: 'typed' });
      tc.broadcast('dedup:playlist', { name: 'x' });
      await tc.cache.save({ redisName: 'probe', file: 'probe.json' }, { a: 1 });
    },
  };
  const run = started(runner.start(task, session('u1'), {}));
  await run.done;

  const sent = owner.messages().filter((m) => m.type !== 'status');
  assert.deepEqual(
    sent.map((m) => [m.type, m.task]),
    [
      ['log', 'dedup-scan'],
      ['log', 'dedup-scan'],
      ['dedup:playlist', 'dedup-scan'],
      ['data:save', 'dedup-scan'],
    ],
  );
  assert.deepEqual(
    other.messages().filter((m) => m.type !== 'status'),
    [],
  );
});
