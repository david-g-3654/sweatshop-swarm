import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shorten, resolve, recordHit, stats, allStats, totalClicks, clicksPerSecond, validateUrl, reset } from './store.js';

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

test('a burst of clicks loses none of them', () => {
  reset();
  const code = shorten('https://example.com');
  for (let i = 0; i < 500; i++) recordHit(code, null);
  assert.equal(stats(code).clicks, 500);
  assert.equal(totalClicks(), 500);
});

test('recording a hit on an unknown code fails softly', () => {
  reset();
  assert.equal(recordHit('nope42', 'x'), false);
});

test('stats for an unknown code is null, not a crash', () => {
  reset();
  assert.equal(stats('nope42'), null);
});

test('allStats ranks busiest first, which is what the chart draws', () => {
  reset();
  const quiet = shorten('https://quiet.example', 'quiet');
  const busy = shorten('https://busy.example', 'busy');
  for (let i = 0; i < 5; i++) recordHit(busy, null);
  recordHit(quiet, null);
  const ranked = allStats();
  assert.equal(ranked[0].code, busy);
  assert.equal(ranked[0].clicks, 5);
  assert.equal(ranked[1].code, quiet);
});

test('clicksPerSecond buckets recent clicks and ignores old ones', () => {
  reset();
  const code = shorten('https://example.com');
  recordHit(code, null);
  const buckets = clicksPerSecond(30);
  assert.equal(buckets.length, 30);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 1);
  assert.equal(buckets[29], 1, 'newest click belongs in the newest bucket');
  // A click from an hour ago must not appear in a 30 second window.
  assert.equal(clicksPerSecond(30, Date.now() + 3_600_000).reduce((a, b) => a + b, 0), 0);
});
