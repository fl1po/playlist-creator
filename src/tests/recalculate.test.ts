import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type SourceSnapshots,
  diffSnapshots,
  shouldSkipRecalculation,
} from '../services/recalculate.js';

// ── diffSnapshots ────────────────────────────────────────────────────────────

test('diffSnapshots: a cold cache (no recorded snapshot) never counts as changed', () => {
  const delta = diffSnapshots({}, { aw: 'aw-1', boaw: 'boaw-1' });
  assert.equal(delta.awChanged, false);
  assert.equal(delta.boawChanged, false);
  assert.equal(delta.anyChanged, false);
});

test('diffSnapshots: flags only the source whose snapshot id actually moved', () => {
  const delta = diffSnapshots(
    { allWeeklySnapshot: 'aw-1', bestOfAllWeeklySnapshot: 'boaw-1' },
    { aw: 'aw-2', boaw: 'boaw-1' },
  );
  assert.equal(delta.awChanged, true);
  assert.equal(delta.boawChanged, false);
  assert.equal(delta.anyChanged, true);
});

// ── shouldSkipRecalculation ──────────────────────────────────────────────────
// Two callers disagree on what a cold cache means: a fill assumes
// trusted-artists.json already exists (skipOnColdCache: true), while the
// recalculate action is what creates that baseline file (skipOnColdCache:
// false). Both share the same "unchanged snapshots" logic underneath.

const UNCHANGED: SourceSnapshots = { aw: 'aw-1', boaw: 'boaw-1' };
const CACHE_FULL = { allWeeklySnapshot: 'aw-1', bestOfAllWeeklySnapshot: 'boaw-1' };
const CACHE_PARTIAL = { allWeeklySnapshot: 'aw-1' };
const CACHE_COLD = {};

test('fill-style gate (skipOnColdCache: true): skips on a cold cache', () => {
  const { skip } = shouldSkipRecalculation(CACHE_COLD, UNCHANGED, {
    skipOnColdCache: true,
  });
  assert.equal(skip, true);
});

test('recalculate-action-style gate (skipOnColdCache: false): never skips on a cold cache', () => {
  const { skip } = shouldSkipRecalculation(CACHE_COLD, UNCHANGED, {
    skipOnColdCache: false,
  });
  assert.equal(skip, false);
});

test('recalculate-action-style gate: never skips on a partial cache either', () => {
  const { skip } = shouldSkipRecalculation(CACHE_PARTIAL, UNCHANGED, {
    skipOnColdCache: false,
  });
  assert.equal(skip, false);
});

test('both gate styles skip when a full cache matches the live snapshots', () => {
  for (const skipOnColdCache of [true, false]) {
    const { skip } = shouldSkipRecalculation(CACHE_FULL, UNCHANGED, {
      skipOnColdCache,
    });
    assert.equal(skip, true);
  }
});

test('both gate styles refuse to skip once a snapshot actually changed', () => {
  const changed: SourceSnapshots = { aw: 'aw-2', boaw: 'boaw-1' };
  for (const skipOnColdCache of [true, false]) {
    const { skip } = shouldSkipRecalculation(CACHE_FULL, changed, {
      skipOnColdCache,
    });
    assert.equal(skip, false);
  }
});

test('returns the underlying delta so callers can feed it to pickReusableScans', () => {
  const changed: SourceSnapshots = { aw: 'aw-2', boaw: 'boaw-1' };
  const { delta } = shouldSkipRecalculation(CACHE_FULL, changed, {
    skipOnColdCache: true,
  });
  assert.deepEqual(delta, { awChanged: true, boawChanged: false, anyChanged: true });
});
