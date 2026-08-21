import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shorten, resolve, recordHit, stats, validateUrl, reset } from './store.js';

test('shortens and resolves a url', () => {
  reset();
  const code = shorten('https://example.com');
  assert.equal(resolve(code), 'https://example.com/');
});

test('rejects input that is not a usable url', () => {
  reset();
  assert.throws(() => shorten(''), /non-empty/);
  assert.throws(() => shorten(null), /non-empty/);
  assert.throws(() => shorten('not a url'), /valid URL/);
  assert.throws(() => shorten('ftp://example.com'), /http or https/);
  assert.throws(() => shorten('https://example.com/' + 'x'.repeat(3000)), /at most/);
});

test('validateUrl normalises rather than echoing input', () => {
  assert.equal(validateUrl('https://EXAMPLE.com'), 'https://example.com/');
});

test('resolve returns undefined for an unknown code', () => {
  reset();
  assert.equal(resolve('nope42'), undefined);
  assert.equal(resolve(undefined), undefined);
});

test('counts clicks and attributes referrers', () => {
  reset();
  const code = shorten('https://example.com');
  recordHit(code, 'https://news.example');
  recordHit(code, null);
  const s = stats(code);
  assert.equal(s.clicks, 2);
  assert.equal(s.referrers['https://news.example'], 1);
  assert.equal(s.referrers.direct, 1);
});

test('recording a hit on an unknown code fails softly', () => {
  reset();
  assert.equal(recordHit('nope42', 'x'), false);
});

test('stats for an unknown code is null, not a crash', () => {
  reset();
  assert.equal(stats('nope42'), null);
});
