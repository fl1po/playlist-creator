import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FEATURED_MULTIPLIER,
  computeArtistData,
} from '../domain/artists.js';
import type { PlaylistArtistData, PlaylistScanResult } from '../lib/types.js';
import { scoreArtist, simulate } from '../services/featured-simulation.js';

// Default weights: awWeight=2, boawWeight=3. AW recency at position 99/100 = +20.

function aw(over: Partial<PlaylistArtistData>): PlaylistArtistData {
  return {
    primaryCount: 0,
    featuredCount: 0,
    latestPosition: 99,
    featuredAtLatest: false,
    id: 'x',
    ...over,
  };
}

test('all-primary artist is unaffected by the multiplier', () => {
  const data = aw({ primaryCount: 10 });
  const base = scoreArtist(data, undefined, 100, 0, 1);
  const treat = scoreArtist(data, undefined, 100, 0, 0.5);
  // 10*2 + recency(20) = 40, identical at both multipliers.
  assert.equal(base.score, 40);
  assert.equal(treat.score, 40);
  assert.equal(treat.priority, base.priority);
});

test('all-featured artist has count and latest-recency halved at 0.5x', () => {
  const data = aw({ featuredCount: 10, featuredAtLatest: true });
  const base = scoreArtist(data, undefined, 100, 0, 1);
  const treat = scoreArtist(data, undefined, 100, 0, 0.5);
  assert.equal(base.score, 40); // 10*2 + 20
  // count: 5*2=10 ; recency: 20*0.5=10 -> 20
  assert.equal(treat.score, 20);
});

test('featured count is halved but recency stays full when latest is primary', () => {
  const data = aw({
    primaryCount: 5,
    featuredCount: 5,
    featuredAtLatest: false,
  });
  const treat = scoreArtist(data, undefined, 100, 0, 0.5);
  // count: (5 + 0.5*5)=7.5 -> *2 = 15 ; recency full 20 -> 35
  assert.equal(treat.score, 35);
});

test('simulate at 1.0x produces zero tier changes', () => {
  const scan: PlaylistScanResult = {
    artistData: new Map([
      ['A', aw({ primaryCount: 40 })],
      ['B', aw({ featuredCount: 30, featuredAtLatest: true })],
    ]),
    totalTracks: 100,
  };
  const empty: PlaylistScanResult = { artistData: new Map(), totalTracks: 0 };
  const result = simulate(scan, empty, 1);
  assert.equal(result.summary.affected, 0);
  assert.equal(result.changes.length, 0);
});

test('computeArtistData defaults to the 0.5 featured multiplier', () => {
  assert.equal(DEFAULT_FEATURED_MULTIPLIER, 0.5);
  const input = {
    allWeekly: aw({ featuredCount: 10, featuredAtLatest: true }),
    bestOfAllWeekly: null,
    awTotal: 100,
    boawTotal: 0,
    spotifyId: null,
  };
  // No multiplier arg → default 0.5: count 5*2=10 + recency 20*0.5=10 = 20.
  const def = computeArtistData(input);
  assert.equal(def.score, 20);
  // Explicit 1.0 → full credit: 10*2 + 20 = 40.
  const full = computeArtistData(input, undefined, undefined, 1);
  assert.equal(full.score, 40);
  // Raw appearance count is preserved for display regardless of multiplier.
  assert.equal(def.allWeekly, 10);
});

test('simulate demotes a feature-heavy artist across the P1 threshold', () => {
  // 30 features: 1.0x -> 60+20=80 (P1). 0.5x -> 15*2=30 + recency 10 = 40 (P2).
  const scan: PlaylistScanResult = {
    artistData: new Map([
      ['Feat', aw({ featuredCount: 30, featuredAtLatest: true })],
    ]),
    totalTracks: 100,
  };
  const empty: PlaylistScanResult = { artistData: new Map(), totalTracks: 0 };
  const result = simulate(scan, empty, 0.5);
  assert.equal(result.summary.affected, 1);
  const change = result.changes[0];
  assert.equal(change.baseTier, 1);
  assert.equal(change.newTier, 2);
  assert.equal(change.direction, 'demotion');
  assert.equal(change.p1p2Crossing, true);
});
