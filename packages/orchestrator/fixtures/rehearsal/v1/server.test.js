import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shorten, resolve, allStats } from './store.js';

test('the store round-trips through the server module', () => {
  const code = shorten('https://example.com/a');
  assert.equal(resolve(code), 'https://example.com/a');
});

test('allStats returns something for the dashboard to draw', () => {
  assert.ok(Array.isArray(allStats()));
});
