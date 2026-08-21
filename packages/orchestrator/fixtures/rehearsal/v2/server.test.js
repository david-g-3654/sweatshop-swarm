import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from './server.js';
import { reset } from './store.js';

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function post(url) {
  return fetch(`${base}/api/shorten`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

test('shortens a url and reports stats', async () => {
  reset();
  const res = await post('https://example.com');
  assert.equal(res.status, 201);
  const { code } = await res.json();

  const redirect = await fetch(`${base}/${code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/');

  const stats = await (await fetch(`${base}/api/stats/${code}`)).json();
  assert.equal(stats.clicks, 1);
});

test('rejects a bad url with 400, not a 500', async () => {
  const res = await post('not-a-url');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid URL/);
});

test('rejects a malformed body with 400', async () => {
  const res = await fetch(`${base}/api/shorten`, {
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
