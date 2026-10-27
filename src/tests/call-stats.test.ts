import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallSummary,
  callKind,
  createCallStats,
} from '../lib/spotify/call-stats.js';

function stats() {
  const reports: Array<{ userId: string } & CallSummary> = [];
  const s = createCallStats({
    report: (userId, summary) => reports.push({ userId, ...summary }),
  });
  return { s, reports };
}

const ok = (description: string, lane: 'interactive' | 'background') => ({
  lane,
  description,
  outcome: 'ok' as const,
});

test('a call kind drops the ids, names and numbers in its description', () => {
  assert.equal(
    callKind('playlist items 37i9dQZF1DXcBWIGoYBM5M'),
    'playlist items …',
  );
  assert.equal(callKind('search artist "Burna Boy"'), 'search artist "…"');
  assert.equal(callKind('album details batch 3'), 'album details batch #');
});

test('a window sums calls by kind, split by page and task', () => {
  const { s, reports } = stats();
  for (let i = 0; i < 3; i++)
    s.record('u1', ok('playback state', 'interactive'));
  s.record('u1', ok('artist 4tZwfgrHOc3mvqYlEYSvVi', 'background'));
  s.record('u1', ok('artist 0iEtIxbK0KxaSlF7G42ZOp', 'interactive'));

  s.report();

  assert.deepEqual(reports, [
    {
      userId: 'u1',
      level: 'debug',
      message:
        'Spotify calls (last 5 min): 5 — playback state ×3 (page), artist … ×2 (1 page, 1 task)',
    },
  ]);
});

test('429s in a window make its summary a warning naming the longest wait', () => {
  const { s, reports } = stats();
  s.record('u1', ok('playback state', 'interactive'));
  s.record('u1', {
    lane: 'interactive',
    description: 'playback state',
    outcome: 'rate_limited',
    retryAfterSeconds: 80100,
  });

  s.report();

  assert.equal(reports[0].level, 'warn');
  assert.match(reports[0].message, /429s: 1 \(Retry-After up to 80100s\)$/);
});

test('a quiet window reports nothing, and windows start over', () => {
  const { s, reports } = stats();
  s.record('u1', ok('playback state', 'interactive'));
  s.report();
  s.report();

  assert.equal(reports.length, 1);
});

test('totals keep counting across windows', () => {
  const { s } = stats();
  s.record('u1', ok('playback state', 'interactive'));
  s.report();
  s.record('u1', ok('playback state', 'background'));
  s.record('u2', ok('user profile', 'interactive'));

  assert.deepEqual(s.totals('u1'), {
    calls: 2,
    rateLimited: 0,
    failed: 0,
    byKind: { 'playback state': { page: 1, task: 1 } },
  });
});

test('a summary names the time each side waited for the pacer', () => {
  const { s, reports } = stats();
  s.record('u1', { ...ok('releases for …', 'background'), queuedMs: 90_000 });
  s.record('u1', { ...ok('playback state', 'interactive'), queuedMs: 1500 });
  s.record('u2', { ...ok('playback state', 'interactive'), queuedMs: 300 });

  s.report();

  assert.match(
    reports[0].message,
    /; waited for pacer: task 1m 30s, page 1\.5s$/,
  );
  // Under a second all told isn't worth a mention.
  assert.doesNotMatch(reports[1].message, /pacer/);
});
