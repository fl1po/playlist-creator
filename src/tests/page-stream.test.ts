import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Effect,
  initialState,
  type PageFacts,
  type PageStreamState,
  receive,
  retentionOf,
  type StreamMessage,
} from '../web/page-stream/index.js';

const page: PageFacts = {
  sessionExpired: false,
  tokens: null,
  loginPending: false,
};

/** Feed messages in order; return the final state and every effect. */
function run(
  messages: StreamMessage[],
  facts: PageFacts = page,
  from: PageStreamState = initialState,
): { state: PageStreamState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const m of messages) {
    const r = receive(state, m, facts);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const live: StreamMessage = { type: 'replay:done', data: null };
const reloads = (effects: Effect[]) =>
  effects.flatMap((e) => (e.kind === 'reload' ? e.targets : []));
const kinds = (effects: Effect[]) => effects.map((e) => e.kind);

const scan = (totalDuplicates: number): StreamMessage => ({
  type: 'dedup:scanComplete',
  data: {
    playlists: totalDuplicates
      ? [{ name: '01.01.26', id: 'p1', duplicateCount: totalDuplicates }]
      : [],
    totalDuplicates,
  },
});

// ── Replay and reloads ──────────────────────────────────────────────────────

test('results replayed on the first connection reload nothing', () => {
  const { effects } = run([
    { type: 'fill:complete', data: { results: [], duration: 1 } },
    { type: 'recalc:complete', data: {} as never },
    { type: 'clear:complete', data: { name: '01.01.26', cleared: 3 } },
  ]);
  assert.deepEqual(reloads(effects), []);
});

test("results after the first replay reload what they changed, a reconnect's replay included", () => {
  const { effects } = run([
    live,
    { type: 'fill:complete', data: { results: [], duration: 1 } },
    { type: 'fill:stopped', data: {} },
    { type: 'fill:recalculated', data: { changes: [] } },
    { type: 'recalc:complete', data: {} as never },
    // A reconnect replays what the page missed, then says so again.
    { type: 'clear:complete', data: { name: '01.01.26', cleared: 3 } },
    live,
  ]);
  assert.deepEqual(
    effects.filter((e) => e.kind === 'reload').map((e) => e.targets),
    [
      ['artists', 'aiPicks', 'stats'],
      ['artists', 'aiPicks', 'stats'],
      ['artists'],
      ['artists', 'stats'],
      ['aiPicks'],
    ],
  );
});

test('a reset empties the log and its cache', () => {
  const { effects } = run([{ type: 'replay:reset', data: null }]);
  assert.deepEqual(kinds(effects), ['resetLog']);
});

// ── Dedup arming ────────────────────────────────────────────────────────────

test('a replayed scan arms nothing: it may be days old', () => {
  const { state, effects } = run([scan(4)]);
  assert.equal(state.dedupScan, null);
  assert.deepEqual(effects, []);
});

test('a live scan arms removal only when it found duplicates', () => {
  const found = run([live, scan(4)]);
  assert.equal(found.state.dedupScan?.totalDuplicates, 4);
  assert.deepEqual(found.effects, [{ kind: 'dedupArmed', armed: true }]);

  const none = run([scan(0)], page, found.state);
  assert.deepEqual(none.effects, [{ kind: 'dedupArmed', armed: false }]);
});

test('a removal, or a new scan starting, disarms the old scan', () => {
  const armed = run([live, scan(4)]).state;

  const removed = run(
    [{ type: 'dedup:complete', data: { totalRemoved: 4 } }],
    page,
    armed,
  );
  assert.equal(removed.state.dedupScan, null);
  assert.deepEqual(removed.effects, [{ kind: 'dedupArmed', armed: false }]);

  const rescanning = run(
    [
      {
        type: 'status',
        data: { busy: true, mine: true, task: 'dedup-scan', stopping: false },
      },
    ],
    page,
    armed,
  );
  assert.equal(rescanning.state.dedupScan, null);
  assert.ok(
    rescanning.effects.some((e) => e.kind === 'dedupArmed' && !e.armed),
  );
});

// ── Status and progress ─────────────────────────────────────────────────────

test("only the owner learns the task's name and sees its progress", () => {
  const other = run([{ type: 'status', data: { busy: true, mine: false } }]);
  assert.deepEqual(other.effects[0], {
    kind: 'task',
    view: { busy: true, mine: false, name: null, stopping: false },
    statusText: 'Busy: another user’s task',
  });
  assert.deepEqual(other.effects[1], { kind: 'progress', progress: null });

  const mine = run([
    {
      type: 'status',
      data: {
        busy: true,
        mine: true,
        task: 'fill',
        stopping: true,
        progress: {
          steps: [{ label: '02.01.26', state: 'active' }],
          bars: [{ key: 'fillCurrent', value: 1, total: 4, text: '1/4' }],
          marked: [],
          waitUntil: 99,
        },
      },
    },
  ]);
  assert.deepEqual(mine.effects[0], {
    kind: 'task',
    view: { busy: true, mine: true, name: 'fill', stopping: true },
    statusText: 'Running: fill',
  });
  assert.deepEqual(mine.effects[1], {
    kind: 'progress',
    progress: {
      steps: [{ label: '02.01.26', state: 'active' }],
      bars: [{ key: 'fillCurrent', value: 1, total: 4, text: '1/4' }],
      waitUntil: 99,
    },
  });
});

test('a full mark list replaces the marks; a live update adds to them', () => {
  const owner = (progress: object): StreamMessage => ({
    type: 'status',
    data: {
      busy: true,
      mine: true,
      task: 'fill',
      stopping: false,
      progress: { steps: [], bars: [], ...progress } as never,
    },
  });
  const { state, effects } = run([
    owner({ marked: ['A', 'B'] }),
    owner({ markedAdded: ['C'] }),
    owner({ markedAdded: [] }),
    owner({ markedAdded: ['D', 'E'] }),
  ]);
  assert.deepEqual([...state.marked], ['A', 'B', 'C', 'D', 'E']);
  assert.equal(state.current, 'E');
  assert.deepEqual(
    effects.filter((e) => e.kind === 'marks'),
    [
      { kind: 'marks', reset: true, done: ['A', 'B'], searched: [] },
      { kind: 'marks', reset: false, done: [], searched: ['C'] },
      { kind: 'marks', reset: false, done: [], searched: ['D', 'E'] },
    ],
  );

  // The task ended: nothing running is nothing drawn (ADR-0006).
  const ended = run(
    [{ type: 'status', data: { busy: false, mine: false } }],
    page,
    state,
  );
  assert.deepEqual([...ended.state.marked], []);
  assert.equal(ended.state.current, null);
});

// ── Log lines ───────────────────────────────────────────────────────────────

test('a log line keeps its own time and task, and a deploy marker is worded', () => {
  const { effects } = run([
    {
      type: 'log',
      data: { level: 'success', message: 'done', ts: 5 },
      ts: 9,
      task: 'fill',
    },
    {
      type: 'server:restarted',
      data: { commit: 'abc123', message: 'fix', branch: 'main' },
      ts: 7,
    },
  ]);
  assert.deepEqual(effects, [
    { kind: 'log', level: 'success', message: 'done', ts: 5, task: 'fill' },
    {
      kind: 'log',
      level: 'warn',
      message:
        'Server restarted — deployed abc123 "fix" (main). Anything running before this was cut off',
      ts: 7,
      task: undefined,
    },
  ]);
});

// ── Session ─────────────────────────────────────────────────────────────────

const pair = { accessToken: 'a2', refreshToken: 'r2' };

test('pushed tokens are stored; a new pair reloads only a page showing the expired banner', () => {
  const save: StreamMessage = {
    type: 'data:save',
    data: { key: 'tokens', value: pair },
  };
  const old = { accessToken: 'a1', refreshToken: 'r1' };

  assert.deepEqual(run([save], { ...page, tokens: old }).effects, [
    { kind: 'storeTokens', tokens: pair },
  ]);
  assert.deepEqual(
    kinds(run([save], { ...page, tokens: old, sessionExpired: true }).effects),
    ['storeTokens', 'reloadPage'],
  );
});

test('a replayed push of the same pair never reloads, so it cannot loop', () => {
  const { effects } = run(
    [
      { type: 'data:save', data: { key: 'tokens', value: pair } },
      { type: 'data:save', data: { key: 'tokens', value: pair } },
    ],
    { ...page, tokens: pair, sessionExpired: true },
  );
  assert.deepEqual(kinds(effects), ['storeTokens', 'storeTokens']);
});

test("a completed login reloads the user's other pages, not the one whose popup is finishing it", () => {
  const done: StreamMessage = { type: 'auth', data: { authenticated: true } };
  assert.deepEqual(kinds(run([done]).effects), ['reloadPage']);
  assert.deepEqual(run([done], { ...page, loginPending: true }).effects, []);
  assert.deepEqual(
    kinds(run([{ type: 'auth', data: { authenticated: false } }]).effects),
    ['showSessionExpired'],
  );
});

// ── History policy ──────────────────────────────────────────────────────────

test('status, auth and reloads are never replayed; token pushes are replayed but not kept', () => {
  for (const t of ['status', 'auth', 'reload', 'replay:done', 'replay:reset'])
    assert.equal(retentionOf(t), 'transient', t);
  assert.equal(retentionOf('data:save'), 'replayed');
  for (const t of [
    'log',
    'server:restarted',
    'fill:complete',
    'clear:complete',
  ])
    assert.equal(retentionOf(t), 'kept', t);
  // A type from elsewhere stays in the history, as before this policy.
  assert.equal(retentionOf('something:new'), 'kept');
});
