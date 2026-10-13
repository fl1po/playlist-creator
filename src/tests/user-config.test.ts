import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeConfigWithDefaults } from '../lib/user-config.js';

test('AI finds default to off, threshold 50, no scouting playlists', () => {
  assert.deepEqual(mergeConfigWithDefaults({}).aiFinds, {
    enabled: false,
    threshold: 50,
    scoutingPlaylists: [],
  });
});

test('a saved AI finds section keeps its values', () => {
  const scouting = [{ id: 'pl1', name: 'Fresh Finds' }];
  const merged = mergeConfigWithDefaults({
    aiFinds: { enabled: true, threshold: 70, scoutingPlaylists: scouting },
  });
  assert.deepEqual(merged.aiFinds, {
    enabled: true,
    threshold: 70,
    scoutingPlaylists: scouting,
  });
});

test('a partial AI finds section fills the rest from defaults', () => {
  const merged = mergeConfigWithDefaults({
    aiFinds: { enabled: true } as never,
  });
  assert.deepEqual(merged.aiFinds, {
    enabled: true,
    threshold: 50,
    scoutingPlaylists: [],
  });
});

test('the AI finds threshold is clamped to 0–100', () => {
  const threshold = (t: number) =>
    mergeConfigWithDefaults({
      aiFinds: { enabled: true, threshold: t, scoutingPlaylists: [] },
    }).aiFinds.threshold;
  assert.equal(threshold(-5), 0);
  assert.equal(threshold(150), 100);
  assert.equal(threshold(0), 0);
  assert.equal(threshold(100), 100);
  assert.equal(threshold(72.6), 73);
});

test('a non-numeric AI finds threshold falls back to the default', () => {
  const merged = mergeConfigWithDefaults({
    aiFinds: {
      enabled: true,
      threshold: 'high' as never,
      scoutingPlaylists: [],
    },
  });
  assert.equal(merged.aiFinds.threshold, 50);
});
