import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSyncDecision } from '../services/promotion-sync/describe.js';
import { describeDecision } from '../services/week-collection/describe.js';
import type { CollectionDecision } from '../services/week-collection/index.js';

type Kind = CollectionDecision['kind'];

/** One row per decision kind: a new kind fails to compile until it has one. */
const ROWS: {
  [K in Kind]: [Extract<CollectionDecision, { kind: K }>, string[]];
} = {
  'release-found': [
    {
      kind: 'release-found',
      artist: 'A',
      release: 'R',
      type: 'single',
      source: 'Editorial',
    },
    ['  Added: A — R (single) [Editorial]'],
  ],
  'variant-picked': [
    { kind: 'variant-picked', release: 'R', variantCount: 3, explicit: true },
    ['  Picked explicit variant of "R" (3 variants)'],
  ],
  'variant-stripped': [
    {
      kind: 'variant-stripped',
      reason: 'instrumental',
      artist: 'A',
      release: 'R',
    },
    ['  Filtered (instrumental): A — R'],
  ],
  'low-popularity': [
    {
      kind: 'low-popularity',
      artist: 'A',
      release: 'R',
      albumId: 'x',
      popularity: 7,
    },
    ['  Filtered (low popularity 7): A — R'],
  ],
  'deluxe-stripped': [
    {
      kind: 'deluxe-stripped',
      release: 'R (Deluxe)',
      baseName: 'R',
      originalTrackCount: 12,
      bonusTracks: 4,
    },
    ['  Deluxe detected: "R (Deluxe)" → "R" (4 bonus of 12)'],
  ],
  'title-track-only': [
    {
      kind: 'title-track-only',
      release: 'R',
      track: 'R',
      oldTracks: 5,
      otherTracks: 6,
    },
    ['  Title track only: "R" — 5/6 other tracks from older releases'],
  ],
  'single-skipped': [
    { kind: 'single-skipped', release: 'R' },
    ['  Skipped single "R" (tracks already on album)'],
  ],
  // AI picks and skips are worded live, from week progress.
  'ai-pick': [
    {
      kind: 'ai-pick',
      artist: 'A',
      release: 'R',
      albumId: 'x',
      confidence: 80,
      reason: 'r',
    },
    [],
  ],
  'ai-skipped': [{ kind: 'ai-skipped', reason: 'failed' }, []],
};

for (const [kind, [decision, expected]] of Object.entries(ROWS)) {
  test(`a ${kind} decision reads the same in a fill and a sync`, () => {
    const fill = describeDecision(decision).map((l) => l.message);
    assert.deepEqual(fill, expected);
    assert.deepEqual(
      describeSyncDecision(decision).map((l) => l.message),
      fill,
    );
  });
}

test('a sync words its removals per playlist, not per decision', () => {
  assert.deepEqual(
    describeSyncDecision({
      kind: 'demotion-removed',
      playlist: 'p',
      artists: ['A'],
      trackCount: 2,
    }),
    [],
  );
});
