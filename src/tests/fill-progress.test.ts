import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskProgress } from '../lib/task-progress.js';
import type { DateResult } from '../lib/types.js';
import { broadcastHandlers } from '../services/playlist-filler/subscribers.js';

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

test('a fill’s events become its owner’s progress', () => {
  const { progress, calls } = recordingProgress();
  const sent: Array<[string, unknown]> = [];
  const h = broadcastHandlers((type, data) => sent.push([type, data]), {
    progress,
    checkAbort: () => {},
  });

  h.onStart?.(['02.01.26', '09.01.26']);
  h.onResumed?.('02.01.26', ['A', 'B']);
  h.onDateStart?.('02.01.26', 0, 2);
  h.onArtistSearchProgress?.(3, 10, 'C');
  h.onDateCompleted?.(result('02.01.26'));
  h.onDateStart?.('09.01.26', 1, 2);
  h.onDateError?.('09.01.26', new Error('boom'));
  h.onBatchComplete?.([], 1);

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
  // Progress is never a message of its own.
  assert.ok(sent.every(([type]) => !/progress|searched/i.test(type)));
});

test('a skipped date shows as skipped, and every 50th artist is logged', () => {
  const { progress, calls } = recordingProgress();
  const lines: string[] = [];
  const h = broadcastHandlers(
    (type, data) => {
      if (type === 'log') lines.push((data as { message: string }).message);
    },
    { progress, checkAbort: () => {} },
  );

  h.onDateStart?.('02.01.26', 0, 1);
  h.onArtistSearchProgress?.(49, 120, 'X');
  h.onArtistSearchProgress?.(50, 120, 'Y');
  h.onDateCompleted?.(result('02.01.26', { skipped: true }));

  assert.ok(calls.includes('step 0 skipped'));
  assert.deepEqual(
    lines.filter((l) => l.includes('Searched')),
    ['  Searched 50/120 artists'],
  );
});
