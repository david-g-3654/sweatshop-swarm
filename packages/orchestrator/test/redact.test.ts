import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep } from '../src/redact.js';

test('redacts an openrouter key out of provider error text', () => {
  const leak =
    'Headers.append: "Bearer sk-or-v1-b773d0ed2a7d7ad53c8d466ba98ed44937954955121ff" is an invalid header value.';
  const safe = redact(leak);
  assert.ok(!safe.includes('b773d0ed'), 'key body must not survive');
  assert.match(safe, /redacted/);
});

test('redacts anthropic keys and bare Bearer tokens', () => {
  assert.ok(!redact('key sk-ant-api03-abcdefghijklmnop').includes('abcdefghijklmnop'));
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('mnopqrstuv'));
});

test('redacts a mangled key that matches no pattern, via the live env value', () => {
  const mangled = 'sk-or-v1-aaa$ export ANTHROPIC_API_KEY= export OPENROUTER_API_KEY=bbb$';
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = mangled;
  try {
    const safe = redact(`Headers.append: "Bearer ${mangled}" is invalid`);
    assert.ok(!safe.includes('export ANTHROPIC_API_KEY'), 'mangled value must not survive');
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test('leaves ordinary text alone', () => {
  const text = 'Reviewer rejected the PR: no input validation on shorten().';
  assert.equal(redact(text), text);
});

test('redactDeep preserves shape while scrubbing nested strings', () => {
  const event = {
    type: 'drama',
    level: 'bad',
    text: 'failed with sk-or-v1-b773d0ed2a7d7ad53c8d466ba98ed44937954955121ff',
    nested: { list: ['sk-ant-api03-zzzzzzzzzzzz', 42, null] },
    count: 7,
  };
  const safe = redactDeep(event);
  assert.equal(safe.type, 'drama');
  assert.equal(safe.count, 7);
  assert.equal(safe.nested.list[1], 42);
  assert.equal(safe.nested.list[2], null);
  assert.ok(!JSON.stringify(safe).includes('b773d0ed'));
  assert.ok(!JSON.stringify(safe).includes('zzzzzzzzzzzz'));
});
