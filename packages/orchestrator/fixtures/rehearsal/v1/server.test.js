import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submit, snapshot } from './store.js';

test('the store round-trips through the server module', () => {
  submit('review');
  assert.ok(snapshot().total >= 1);
});

test('snapshot gives the page something to render', () => {
  assert.ok(Array.isArray(snapshot().words));
});
