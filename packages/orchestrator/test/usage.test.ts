import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageMeter } from '../src/usage.js';

const usage = (over: Partial<Record<string, number>> = {}) =>
  ({
    input_tokens: 1000,
    output_tokens: 1000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  }) as never;

test('prices sonnet at 2 in / 10 out per million', () => {
  const meter = new UsageMeter();
  meter.record('claude-sonnet-5', usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
  assert.equal(meter.totals().costUsd.toFixed(2), '12.00');
});

test('treats an openrouter vendor prefix as the same model', () => {
  const bare = new UsageMeter();
  const prefixed = new UsageMeter();
  bare.record('claude-opus-5', usage());
  prefixed.record('anthropic/claude-opus-5', usage());
  assert.equal(bare.totals().costUsd, prefixed.totals().costUsd);
  assert.equal(prefixed.totals().incomplete, false);
});

test('cache reads cost a tenth of fresh input', () => {
  const fresh = new UsageMeter();
  const cached = new UsageMeter();
  fresh.record('claude-sonnet-5', usage({ input_tokens: 100_000, output_tokens: 0 }));
  cached.record('claude-sonnet-5', usage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 }));
  assert.ok(Math.abs(cached.totals().costUsd * 10 - fresh.totals().costUsd) < 1e-9);
});

test('an unpriced model reports the cost as a floor, not as zero', () => {
  const meter = new UsageMeter();
  meter.record('some/unknown-model', usage());
  const totals = meter.totals();
  assert.equal(totals.incomplete, true);
  assert.equal(totals.input, 1000);
  assert.match(meter.summary(), /at least/);
});

test('summary reports cache savings only when there are some', () => {
  const meter = new UsageMeter();
  meter.record('claude-sonnet-5', usage());
  assert.doesNotMatch(meter.summary(), /from cache/);
  meter.record('claude-sonnet-5', usage({ cache_read_input_tokens: 50_000 }));
  assert.match(meter.summary(), /50k served from cache/);
});
