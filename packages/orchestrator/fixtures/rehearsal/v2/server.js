import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { submit, snapshot, reset } from './store.js';

/** Show plenty, and say so when there is more rather than hiding it. */
const CLOUD_LIMIT = 150;

const port = process.env.PORT || 4310;
const MAX_BODY_BYTES = 4096;

/** Every connected screen. Entries are removed when the client goes away. */
const subscribers = new Set();

/** Per-client submission budget, so one held-down finger cannot own the cloud. */
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 10_000;
const recent = new Map();

function rateLimited(clientId) {
  const now = Date.now();
  const hits = (recent.get(clientId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(clientId, hits);
  // Bounded: the map must not accumulate a key per visitor for ever.
  if (recent.size > 5000) recent.clear();
  return hits.length > RATE_LIMIT;
}

/** Always built fresh, and always after the write it is reporting. */
function broadcast() {
  const frame = `data: ${JSON.stringify(snapshot(CLOUD_LIMIT))}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('request body too large');
  }
  return body;
}

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live word cloud</title>
<style>
:root{--bg:#0e131c;--panel:#161d2b;--rule:#2b3548;--ink:#e9eef8;--dim:#8493ad;--amber:#ffb454;--go:#58d5a0;--blue:#7c9cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:70rem;margin:0 auto;padding:1rem}
h1{font-size:1rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 .7rem;font-weight:700}
.card{background:var(--panel);border:1px solid var(--rule);padding:.9rem;margin-bottom:.7rem}
.counts{display:flex;gap:2rem;margin:0 0 .6rem}
.counts b{color:var(--amber);font-size:2.2rem;line-height:1;display:block;font-variant-numeric:tabular-nums}
.counts span{color:var(--dim);font-size:.7rem;letter-spacing:.16em;text-transform:uppercase}
#cloud{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:.35rem;min-height:9rem;padding:.5rem}
/* Padding in em is relative to the span's OWN font size, so big words get
   proportionally big breathing room. A container gap cannot do that. */
#cloud span{line-height:1.05;padding:0 .18em;transition:font-size .35s ease,color .35s ease}
form{display:flex;gap:.5rem;flex-wrap:wrap}
input,button{font:inherit;padding:.7rem;background:var(--bg);color:var(--ink);border:1px solid var(--rule)}
input{flex:1 1 14rem;min-width:0}
button{border-color:var(--amber);color:var(--amber);cursor:pointer;font-weight:600}
button:active{background:var(--amber);color:var(--bg)}
#msg{color:var(--dim);margin:.5rem 0 0;min-height:1.2em;font-size:.85rem}
.empty{color:var(--dim);font-size:.9rem}
</style></head><body><div class="wrap">
<h1>Live word cloud</h1>

<div class="card">
  <p class="counts">
    <span>Words<b id="total">0</b></span>
    <span>Unique<b id="unique">0</b></span>
  </p>
  <div id="cloud"><span class="empty">Nobody has said anything yet.</span></div>
  <p id="more" class="empty"></p>
</div>

<div class="card">
  <form onsubmit="return send(event)">
    <input id="w" placeholder="one word" autocomplete="off" autocapitalize="off" maxlength="24">
    <button>Add it</button>
  </form>
  <p id="msg"></p>
</div>
</div>
<script>
var PALETTE = ['#ffb454', '#58d5a0', '#7c9cff', '#f472b6', '#22d3ee'];

function render(data) {
  document.getElementById('total').textContent = data.total;
  document.getElementById('unique').textContent = data.unique;

  var cloud = document.getElementById('cloud');
  cloud.textContent = '';

  var hidden = data.unique - data.words.length;
  document.getElementById('more').textContent =
    hidden > 0 ? '+ ' + hidden + ' more said once or twice' : '';

  if (!data.words.length) {
    var empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = 'Nobody has said anything yet.';
    cloud.appendChild(empty);
    return;
  }

  data.words.forEach(function (entry, i) {
    // createElement + textContent, never innerHTML. These words come from
    // strangers on the internet; they are text, and they are only ever text.
    var node = document.createElement('span');
    node.textContent = entry.word;
    node.title = entry.word + ' — ' + entry.count;
    node.style.fontSize = (0.95 + entry.weight * 3.6).toFixed(2) + 'rem';
    node.style.color = PALETTE[i % PALETTE.length];
    node.style.opacity = String(0.55 + entry.weight * 0.45);
    cloud.appendChild(node);
  });
}

function send(e) {
  e.preventDefault();
  var input = document.getElementById('w');
  fetch('/api/words', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word: input.value })
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, d: d }; });
  }).then(function (res) {
    document.getElementById('msg').textContent = res.ok
      ? 'Added "' + res.d.word + '".'
      : 'Nope: ' + res.d.error;
    if (res.ok) input.value = '';
  });
  return false;
}

var stream;
function connect() {
  stream = new EventSource('/api/stream');
  stream.onmessage = function (ev) { render(JSON.parse(ev.data)); };
  stream.onerror = function () { stream.close(); setTimeout(connect, 2000); };
}
connect();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad request line' });
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot(CLOUD_LIMIT))}\n\n`);
    subscribers.add(res);
    // Without this the set grows for the life of the process.
    const drop = () => subscribers.delete(res);
    req.on('close', drop);
    req.on('error', drop);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/words') {
    const clientId = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
    if (rateLimited(clientId)) {
      return json(res, 429, { error: 'slow down — too many words too quickly' });
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: `body must be valid JSON (${err.message})` });
    }

    try {
      const word = submit(payload?.word, clientId);
      broadcast();
      return json(res, 201, { word });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/words') return json(res, 200, snapshot(CLOUD_LIMIT));
  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    reset();
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (url.pathname !== '/') return json(res, 404, { error: `no such path: ${url.pathname}` });

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log(`listening on ${port}`));
}

export { server, subscribers };
