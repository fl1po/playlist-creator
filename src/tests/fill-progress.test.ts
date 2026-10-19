import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskProgress } from '../lib/task-progress.js';
import type { DateResult } from '../lib/types.js';
import type { FillEvent } from '../services/playlist-filler/events.js';
import { webFillSink } from '../services/playlist-filler/subscribers.js';

/** Records each progress call as one readable line. */
function recordingProgress() {
  const calls: string[] = [];
  const progress: TaskProgress = {
    steps: (labels) => calls.push(`steps ${labels.join(',')}`),
    step: (i, state) => calls.push(`step ${i} ${state}`),
    bar: (key, value, total, text) =>
      calls.push(`bar ${key} ${value}/${total} ${text}`),
    clearBar: (key) => calls.push(`clearBar ${key}`),
    mark: (...names) => calls.push(`mark ${names.join(',')}`),
  };
  return { progress, calls };
}

const result = (date: string, extra: Partial<DateResult> = {}) =>
  ({ date, tracksAdded: 4, ...extra }) as DateResult;

const searching = (searched: number, total: number, artist: string) =>
  ({
    kind: 'week',
    event: { phase: 'searching', searched, total, artist },
  }) as const;

/** A web fill sink recording its log lines and its result messages. */
function recordingSink() {
  const { progress, calls } = recordingProgress();
  const lines: string[] = [];
  const results: Array<[string, unknown]> = [];
  const sink = webFillSink({
    log: (_level, message) => lines.push(message),
    emit: (type, data) => results.push([type, data]),
    progress,
    checkAbort: () => {},
  });
  return { sink, calls, lines, results };
}

test('a fill’s events become its owner’s progress', () => {
  const { sink, calls, results } = recordingSink();

  const events: FillEvent[] = [
    { kind: 'start', dates: ['02.01.26', '09.01.26'] },
    { kind: 'resumed', date: '02.01.26', artists: ['A', 'B'] },
    { kind: 'date-start', date: '02.01.26', index: 0, total: 2 },
    searching(3, 10, 'C'),
    { kind: 'date-complete', result: result('02.01.26') },
    { kind: 'date-start', date: '09.01.26', index: 1, total: 2 },
    { kind: 'date-error', date: '09.01.26', error: new Error('boom') },
    { kind: 'complete', results: [], durationMinutes: 1 },
  ];
  for (const e of events) sink(e);

  assert.deepEqual(calls, [
    'steps 02.01.26,09.01.26',
    'bar fillCurrent 0/1 Starting...',
    'mark A,B',
    'step 0 active',
    'bar fillCurrent 0/1 02.01.26: starting...',
    'mark C',
    'bar fillCurrent 3/10 Searching artists: 3/10',
    'step 0 done',
    'bar fillCurrent 1/1 02.01.26: done — 4 tracks',
    'step 1 active',
    'bar fillCurrent 0/1 09.01.26: starting...',
    'step 1 error',
    'steps ',
    'clearBar fillCurrent',
  ]);
  // Progress is never a message of its own; only results the page acts on are.
  assert.deepEqual(
    results.map(([type]) => type),
    ['fill:complete'],
  );
});

test('a skipped date shows as skipped, and every 50th artist is logged', () => {
  const { sink, calls, lines } = recordingSink();

  sink({ kind: 'date-start', date: '02.01.26', index: 0, total: 1 });
  sink(searching(49, 120, 'X'));
  sink(searching(50, 120, 'Y'));
  sink({
    kind: 'date-complete',
    result: result('02.01.26', { skipped: true }),
  });

  assert.ok(calls.includes('step 0 skipped'));
  assert.deepEqual(
    lines.filter((l) => l.includes('Searched')),
    ['  Searched 50/120 artists'],
  );
});

test('a mid-fill recalculation is logged and sent for the page to reload', () => {
  const { sink, lines, results } = recordingSink();
  const changes = [{ artist: 'A', from: 1, to: 3 }];

  sink({ kind: 'recalculated', changes });

  assert.deepEqual(lines, ['1 artist(s) changed priority:', '  P1 → P3: A']);
  assert.deepEqual(results, [['fill:recalculated', { changes }]]);
});
