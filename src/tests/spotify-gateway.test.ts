import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { Clock } from '../lib/spotify/clock.js';
import { HttpError, RateLimitError } from '../lib/spotify/errors.js';
import type { SpotifyEvent } from '../lib/spotify/events.js';
import {
  createSpotifyGateway,
  type GatewayOptions,
  RequestPacer,
  SpotifyAuthLost,
  TaskAborted,
} from '../lib/spotify/gateway.js';
import { timedFetch } from '../lib/spotify/http.js';
import type { RefreshOutcome } from '../lib/spotify/tokens.js';
import type { ConfigStore, SpotifyConfig } from '../lib/types.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Time only moves when someone sleeps; sleeping never really waits. */
function fakeClock(start = 1_000_000): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    async sleep(ms, signal) {
      signal?.throwIfAborted();
      slept.push(ms);
      now += ms;
      await Promise.resolve();
      signal?.throwIfAborted();
    },
  };
}

/** A clock whose sleeps only end by aborting. */
function hangingClock(): Clock {
  return {
    now: () => 1_000_000,
    sleep: (_ms, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason)),
      ),
  };
}

function memoryStore(accessToken = 'a0', refreshToken = 'r0') {
  let config: SpotifyConfig = {
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://x',
    accessToken,
    refreshToken,
  };
  const store: ConfigStore & { current: () => SpotifyConfig } = {
    load: () => config,
    save: (c) => {
      config = c;
    },
    current: () => config,
  };
  return store;
}

/** The fake SDK is just the access token it was built with. */
type FakeApi = { token: string };
const tokenOf = (api: SpotifyApi) => (api as unknown as FakeApi).token;

function grantSequence(...outcomes: RefreshOutcome[]) {
  const calls: string[] = [];
  return {
    calls,
    grant: async (_app: unknown, refreshToken: string) => {
      calls.push(refreshToken);
      const next = outcomes.shift();
      if (!next) throw new Error('unexpected refresh');
      return next;
    },
  };
}

const ok = (n: number): RefreshOutcome => ({
  kind: 'ok',
  accessToken: `a${n}`,
  refreshToken: `r${n}`,
  expiresIn: 3600,
});

function gateway(overrides: Partial<GatewayOptions> = {}) {
  const clock =
    (overrides.clock as ReturnType<typeof fakeClock>) ?? fakeClock();
  const events: SpotifyEvent[] = [];
  const store = memoryStore();
  const gw = createSpotifyGateway({
    configStore: store,
    pacer: new RequestPacer(1, clock),
    clock,
    sdk: (_id, tokens) =>
      ({ token: tokens.accessToken }) as unknown as SpotifyApi,
    grant: grantSequence().grant,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { gw, clock, events, store };
}

/** Throws each scripted error in turn, then returns the token it ran with. */
function script(...errors: Error[]) {
  const tokens: string[] = [];
  return {
    tokens,
    fn: async (api: SpotifyApi) => {
      tokens.push(tokenOf(api));
      const err = errors.shift();
      if (err) throw err;
      return tokenOf(api);
    },
  };
}

// ── Pacing ──────────────────────────────────────────────────────────────────

test('consecutive calls are spaced by the pacer interval', async () => {
  const { gw, clock } = gateway();
  await gw.call(async () => 1, 'first');
  const before = clock.now();
  await gw.call(async () => 2, 'second');
  assert.ok(clock.now() - before >= 1000);
});

test('an interactive call waiting alongside background ones goes next', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer(1, clock);
  const order: string[] = [];
  const background = new AbortController().signal;
  const turns = [
    pacer.pace('background', background).then(() => order.push('bg1')),
    pacer.pace('background', background).then(() => order.push('bg2')),
    pacer.pace('interactive').then(() => order.push('ui')),
  ];
  await Promise.all(turns);
  assert.deepEqual(order, ['bg1', 'ui', 'bg2']);
});

// ── Rate limits ─────────────────────────────────────────────────────────────

test('a 429 waits out Retry-After and retries', async () => {
  const { gw, clock, events } = gateway({ lane: 'background' });
  const s = script(new RateLimitError(4));
  const result = await gw.call(s.fn, 'read');
  assert.deepEqual(result, { success: true, data: 'a0' });
  assert.ok(clock.slept.includes(5000));
  assert.equal(events[0].type, 'rateLimitWait');
});

test('persistent 429s put background calls to sleep and interactive calls fail fast meanwhile', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer(1, clock);
  const base = {
    pacer,
    clock,
    retry: { rateLimit: { maxRetries: 1, longSleepMs: () => 3_600_000 } },
    grant: grantSequence(ok(1)).grant,
  };
  // Another user's gateway on the same server-wide pacer.
  const otherUser = gateway({ ...base }).gw;
  const events: SpotifyEvent[] = [];
  let duringBan: ReturnType<typeof otherUser.call> | undefined;
  const task = gateway({ ...base }).gw.forTask({
    signal: new AbortController().signal,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'longSleep') {
        duringBan = otherUser.call(async () => 'x', 'ui');
      }
    },
  });

  const s = script(new RateLimitError(1), new RateLimitError(1));
  const result = await task.call(s.fn, 'read');

  assert.equal(result.success, true);
  assert.ok(events.some((e) => e.type === 'longSleepWake'));
  const refused = await duringBan;
  assert.equal(refused?.success, false);
  if (refused && !refused.success) assert.equal(refused.kind, 'rate_limited');
  // Once the ban is over, interactive calls go through again.
  const after = await otherUser.call(async () => 'x', 'ui');
  assert.equal(after.success, true);
});

test('an interactive call during a ban returns rate_limited with retryAt', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer(1, clock);
  pacer.ban(clock.now() + 60_000);
  const { gw } = gateway({ pacer, clock });
  const result = await gw.call(async () => 'x', 'ui');
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.retryAt?.getTime(), clock.now() + 60_000);
});

test('an interactive call refuses a long Retry-After instead of waiting', async () => {
  const { gw } = gateway();
  const result = await gw.call(script(new RateLimitError(120)).fn, 'ui');
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.kind, 'rate_limited');
});

test('a long Retry-After an interactive call refused holds a task back, and the task says so', async () => {
  const clock = fakeClock();
  const pacer = new RequestPacer(1, clock);
  const ui = gateway({ pacer, clock }).gw;
  await ui.call(script(new RateLimitError(120)).fn, 'ui');
  const banEnd = clock.now() + 121_000;

  const events: SpotifyEvent[] = [];
  const task = gateway({ pacer, clock }).gw.forTask({
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  const calledAt: number[] = [];
  const result = await task.call(async () => {
    calledAt.push(clock.now());
    return 'x';
  }, 'read');

  assert.equal(result.success, true);
  assert.deepEqual(
    events.map((e) => e.type),
    ['rateLimitWait'],
  );
  assert.equal(
    events[0].type === 'rateLimitWait' && events[0].until.getTime(),
    banEnd,
  );
  assert.equal(calledAt.length, 1);
  assert.ok(calledAt[0] >= banEnd);
});

test('after a long Retry-After, interactive calls fail fast without asking Spotify', async () => {
  const { gw } = gateway();
  await gw.call(script(new RateLimitError(120)).fn, 'ui');
  const again = script();
  const result = await gw.call(again.fn, 'ui');
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.kind, 'rate_limited');
  assert.equal(again.tokens.length, 0);
});

// ── Auth ────────────────────────────────────────────────────────────────────

test('a 401 refreshes once and retries with the new token', async () => {
  const g = grantSequence(ok(1));
  const { gw, store } = gateway({ grant: g.grant });
  const s = script(new HttpError(401, 'expired'));
  const result = await gw.call(s.fn, 'read');
  assert.deepEqual(result, { success: true, data: 'a1' });
  assert.deepEqual(s.tokens, ['a0', 'a1']);
  assert.equal(store.current().refreshToken, 'r1');
});

test('concurrent 401s share one refresh', async () => {
  const g = grantSequence(ok(1));
  const { gw } = gateway({ grant: g.grant });
  // Both calls run with the old token before either sees its 401.
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((r) => {
    release = r;
  });
  const staleRejects = async (api: SpotifyApi) => {
    if (tokenOf(api) !== 'a0') return tokenOf(api);
    if (++started === 2) release();
    await bothStarted;
    throw new HttpError(401, 'expired');
  };
  const results = await Promise.all([
    gw.call(staleRejects, 'a'),
    gw.call(staleRejects, 'b'),
  ]);
  assert.ok(results.every((r) => r.success));
  assert.equal(g.calls.length, 1);
});

test('a rejected refresh token throws SpotifyAuthLost on the interactive lane', async () => {
  const g = grantSequence({ kind: 'rejected', error: new Error('dead') });
  let reauthCalled = false;
  const { gw } = gateway({
    grant: g.grant,
    reauth: async () => {
      reauthCalled = true;
      return true;
    },
    authLostHint: 'Log in again.',
  });
  await assert.rejects(
    gw.call(script(new HttpError(401, 'x')).fn, 'ui'),
    (e: Error) =>
      e instanceof SpotifyAuthLost && /Log in again/.test(e.message),
  );
  assert.equal(reauthCalled, false);
});

test('a rejected refresh token waits for a login on the background lane', async () => {
  const g = grantSequence({ kind: 'rejected', error: new Error('dead') });
  const { gw } = gateway({
    grant: g.grant,
    reauth: async () => {
      gw.setTokens({ accessToken: 'login', refreshToken: 'r-login' }, 3600);
      return true;
    },
  });
  const task = gw.forTask({ signal: new AbortController().signal });
  const s = script(new HttpError(401, 'x'));
  const result = await task.call(s.fn, 'read');
  assert.deepEqual(result, { success: true, data: 'login' });
});

test('a failed login throws SpotifyAuthLost', async () => {
  const g = grantSequence({ kind: 'rejected', error: new Error('dead') });
  const { gw } = gateway({ grant: g.grant, reauth: async () => false });
  const task = gw.forTask({ signal: new AbortController().signal });
  await assert.rejects(
    task.call(script(new HttpError(401, 'x')).fn, 'read'),
    SpotifyAuthLost,
  );
});

test('a token close to expiry is refreshed before the call', async () => {
  const g = grantSequence(ok(1));
  const { gw, clock } = gateway({ grant: g.grant });
  gw.setTokens({ accessToken: 'fresh', refreshToken: 'r-fresh' }, 3600);
  await clock.sleep(56 * 60 * 1000);
  const s = script();
  await gw.call(s.fn, 'read');
  assert.deepEqual(s.tokens, ['a1']);
  assert.deepEqual(g.calls, ['r-fresh']);
});

test('setTokens with unchanged tokens keeps the known expiry', async () => {
  const g = grantSequence(ok(1));
  const { gw, clock } = gateway({ grant: g.grant });
  gw.setTokens({ accessToken: 'fresh', refreshToken: 'r-fresh' }, 3600);
  await clock.sleep(56 * 60 * 1000);
  gw.setTokens({ accessToken: 'fresh', refreshToken: 'r-fresh' });
  await gw.call(script().fn, 'read');
  assert.equal(g.calls.length, 1);
});

// ── Failures ────────────────────────────────────────────────────────────────

test('server errors are retried, then reported as kind server', async () => {
  const { gw, events } = gateway({
    retry: { server: { maxRetries: 2, baseDelayMs: 1 } },
  });
  const s = script(
    new HttpError(503, 'down'),
    new HttpError(503, 'down'),
    new HttpError(503, 'down'),
  );
  const result = await gw.call(s.fn, 'read');
  assert.equal(s.tokens.length, 3);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.kind, 'server');
  assert.equal(events.at(-1)?.type, 'callFailed');
});

test('a timed-out call is retried as a network error', async () => {
  const { gw, events } = gateway();
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  const s = script(timeout);
  const result = await gw.call(s.fn, 'read');
  assert.equal(s.tokens.length, 2);
  assert.equal(result.success, true);
  assert.equal(events[0]?.type, 'networkRetry');
});

test('a request that stalls is cut off with a TimeoutError', async () => {
  // Never answers; only its signal can end it.
  const stalled: typeof fetch = (_input, init) =>
    new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason),
      ),
    );
  // The timeout's own timer doesn't hold the event loop open.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(timedFetch(10, stalled)('https://api.spotify.com'), {
    name: 'TimeoutError',
  });
  clearTimeout(keepAlive);
});

test('a 404 comes back as kind client without a retry', async () => {
  const { gw, events } = gateway();
  const s = script(new HttpError(404, 'Unrecognised response code: 404'));
  const result = await gw.call(s.fn, 'read');
  assert.equal(s.tokens.length, 1);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.kind, 'client');
  assert.equal(events.length, 0);
});

// ── Abort ───────────────────────────────────────────────────────────────────

test('stopping a task interrupts a retry wait with TaskAborted', async () => {
  const { gw } = gateway({ clock: hangingClock() });
  const controller = new AbortController();
  const task = gw.forTask({ signal: controller.signal });
  const pending = task.call(script(new HttpError(503, 'down')).fn, 'read');
  setImmediate(() => controller.abort(new TaskAborted()));
  await assert.rejects(pending, TaskAborted);
});

test('a stopped task makes no further calls', async () => {
  const { gw } = gateway();
  const controller = new AbortController();
  controller.abort(new TaskAborted());
  const task = gw.forTask({ signal: controller.signal });
  const s = script();
  await assert.rejects(task.call(s.fn, 'read'), TaskAborted);
  assert.equal(s.tokens.length, 0);
});
