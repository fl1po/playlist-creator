import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBaseAlbumName } from '../domain/releases.js';
import { HttpError, classifyError } from '../lib/resilience/errors.js';

test('getBaseAlbumName strips anniversary editions in every suffix form', () => {
  for (const name of [
    'Album (20th Anniversary Edition)',
    'Album - Anniversary Edition',
    'Album - 10th Anniversary Edition',
    'Album 20th Anniversary Edition',
  ]) {
    assert.equal(getBaseAlbumName(name), 'Album', name);
  }
});

test('getBaseAlbumName leaves a bare number before an edition keyword alone', () => {
  assert.equal(getBaseAlbumName('Album 2 Deluxe'), 'Album 2');
});

test('classifyError retries HTTP 500 like the other server errors', () => {
  assert.equal(classifyError(new HttpError(500, 'x')).kind, 'server');
  assert.equal(classifyError(new HttpError(503, 'x')).kind, 'server');
  assert.equal(classifyError(new HttpError(404, 'x')).kind, 'unknown');
});
