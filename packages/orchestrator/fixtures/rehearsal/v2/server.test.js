import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server, subscribers } from './server.js';
import { reset } from './store.js';

let base;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const say = (word) =>
  fetch(`${base}/api/words`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word }),
  });

const clear = async () => {
  reset();
  await fetch(`${base}/api/reset`, { method: 'POST' });
};

test('accepts a word and reports it in the snapshot', async () => {
  await clear();
  const res = await say('agents');
  assert.equal(res.status, 201);
  assert.equal((await res.json()).word, 'agents');

  const snap = await (await fetch(`${base}/api/words`)).json();
  assert.equal(snap.total, 1);
  assert.equal(snap.words[0].word, 'agents');
});

test('the page can update without the stream working at all', async () => {
  // A live page whose only update path is a stream is one buffering proxy away
  // from never updating. It must poll as well, and it must render on load
  // rather than waiting for a first message that may never arrive.
  const body = await (await fetch(`${base}/`)).text();
  assert.match(body, /setInterval\(\s*refresh/, 'the page must poll as a fallback');
  assert.match(body, /refresh\(\)/, 'the page must render on load, not wait for a stream');
});

test('serves a page that renders text, never markup', async () => {
  const body = await (await fetch(`${base}/`)).text();
  assert.match(body, /Live word cloud/);
  assert.match(body, /EventSource/, 'the page must subscribe to updates');
  assert.match(body, /textContent/, 'words must be set as text');
  // Match the sink, not the word: a comment saying "never innerHTML" is not a
  // vulnerability, and a test that cannot tell the difference is noise.
  assert.doesNotMatch(body, /\.innerHTML\s*=/, 'nothing may assign submitted words into HTML');
  assert.doesNotMatch(body, /insertAdjacentHTML|document\.write/, 'no other HTML sink either');
});

test('a submitted tag cannot reach the page as markup', async () => {
  await clear();
  await say('<img src=x onerror=alert(1)>');
  const snap = await (await fetch(`${base}/api/words`)).json();
  for (const entry of snap.words) {
    assert.doesNotMatch(entry.word, /[<>]/, `stored word "${entry.word}" still carries a tag`);
  }
});

test('rejects unusable input with 400, not 500', async () => {
  assert.equal((await say('')).status, 400);
  assert.equal((await say('!!!')).status, 400);
  assert.equal((await say(null)).status, 400);
  assert.equal((await say('x'.repeat(80))).status, 400);
});

test('rejects a malformed body with 400', async () => {
  const res = await fetch(`${base}/api/words`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oh no',
  });
  assert.equal(res.status, 400);
});

test('rate limits one client hammering the endpoint', async () => {
  await clear();
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    if ((await say('flood')).status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'a single client must not be able to submit without limit');
});

test('rotating a client-supplied header does not buy a fresh quota', async () => {
  await clear();
  // The limiter must not key on anything the caller picks. If it does, this
  // loop sails through and the limit only ever throttles honest users.
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${base}/api/words`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': `rotating-${i}` },
      body: JSON.stringify({ word: 'flood' }),
    });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'a rotating client id must not defeat the rate limit');
});

test('the stream sends a snapshot and is cleaned up on disconnect', async () => {
  const before = subscribers.size;
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^data: /);
  assert.equal(subscribers.size, before + 1);

  controller.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(subscribers.size, before, 'a disconnected client must not be retained');
});

test('unknown paths return 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
