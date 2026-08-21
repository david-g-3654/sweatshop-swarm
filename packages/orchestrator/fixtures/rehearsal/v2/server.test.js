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

const create = (url, label) =>
  fetch(`${base}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, label }),
  });

test('shortens a url and reports it on the dashboard feed', async () => {
  reset();
  const res = await create('https://example.com', 'demo');
  assert.equal(res.status, 201);
  const { code } = await res.json();

  const redirect = await fetch(`${base}/${code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/');

  const snap = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(snap.total, 1);
  assert.equal(snap.links[0].label, 'demo');
});

test('serves a dashboard page at the root', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Live click analytics/);
  assert.match(body, /EventSource/, 'the page must actually subscribe to updates');
});

test('a burst of concurrent clicks is counted exactly', async () => {
  reset();
  const { code } = await (await create('https://example.com')).json();
  await Promise.all(
    Array.from({ length: 200 }, () => fetch(`${base}/${code}`, { redirect: 'manual' })),
  );
  const snap = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(snap.total, 200, 'no clicks may be lost when they arrive together');
});

test('the stream sends a snapshot and is cleaned up on disconnect', async () => {
  reset();
  const before = subscribers.size;
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^data: /);
  assert.equal(subscribers.size, before + 1);

  controller.abort();
  // Give the server a tick to notice the socket closed.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(subscribers.size, before, 'a disconnected client must not be retained');
});

test('rejects a bad url with 400, not a 500', async () => {
  const res = await create('not-a-url');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid URL/);
});

test('rejects a malformed body with 400', async () => {
  const res = await fetch(`${base}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oh no',
  });
  assert.equal(res.status, 400);
});

test('unknown code returns 404 on both redirect and stats', async () => {
  assert.equal((await fetch(`${base}/zzzz99`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/api/stats/zzzz99`)).status, 404);
});
