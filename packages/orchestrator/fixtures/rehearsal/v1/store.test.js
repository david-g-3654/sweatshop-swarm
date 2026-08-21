import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shorten, resolve, recordHit, stats } from './store.js';

test('shortens and resolves a url', () => {
  const code = shorten('https://example.com');
  assert.equal(resolve(code), 'https://example.com');
});

test('counts clicks', () => {
  const code = shorten('https://example.com');
  recordHit(code, 'test');
  recordHit(code, 'test');
  assert.equal(stats(code).clicks, 2);
});
