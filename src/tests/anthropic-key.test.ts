import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiFindsAvailable } from '../lib/anthropic-key.js';

test('AI finds are available only when ANTHROPIC_API_KEY is set', () => {
  assert.equal(aiFindsAvailable({}), false);
  assert.equal(aiFindsAvailable({ ANTHROPIC_API_KEY: '' }), false);
  assert.equal(aiFindsAvailable({ ANTHROPIC_API_KEY: 'sk-ant-test' }), true);
});
