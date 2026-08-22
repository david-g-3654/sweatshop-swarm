import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { submit, snapshot, reset } from './store.js';

const port = process.env.PORT || 4310;

const subscribers = new Set();

function broadcast(frame) {
  for (const res of subscribers) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live word cloud</title>
<style>
:root{--bg:#0e131c;--panel:#161d2b;--rule:#2b3548;--ink:#e9eef8;--dim:#8493ad;--amber:#ffb454}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:70rem;margin:0 auto;padding:1rem}
h1{font-size:1rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 .7rem;font-weight:700}
.card{background:var(--panel);border:1px solid var(--rule);padding:.9rem;margin-bottom:.7rem}
.counts{display:flex;gap:2rem;margin:0 0 .6rem}
.counts b{color:var(--amber);font-size:2.2rem;line-height:1;display:block}
.counts span{color:var(--dim);font-size:.7rem;letter-spacing:.16em;text-transform:uppercase}
#cloud{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:.15em .5em;min-height:9rem;padding:.5rem}
form{display:flex;gap:.5rem;flex-wrap:wrap}
input,button{font:inherit;padding:.7rem;background:var(--bg);color:var(--ink);border:1px solid var(--rule)}
input{flex:1 1 14rem;min-width:0}
button{border-color:var(--amber);color:var(--amber);cursor:pointer;font-weight:600}
</style></head><body><div class="wrap">
<h1>Live word cloud</h1>
<div class="card">
  <p class="counts"><span>Words<b id="total">0</b></span><span>Unique<b id="unique">0</b></span></p>
  <div id="cloud"></div>
</div>
<div class="card">
  <form onsubmit="return send(event)">
    <input id="w" placeholder="one word" autocomplete="off">
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
  var html = '';
  data.words.forEach(function (entry, i) {
    var size = (0.95 + entry.weight * 3.6).toFixed(2);
    var colour = PALETTE[i % PALETTE.length];
    html += '<span style="font-size:' + size + 'rem;color:' + colour + '">' + entry.word + '</span>';
  });
  document.getElementById('cloud').innerHTML = html;
}

function send(e) {
  e.preventDefault();
  var input = document.getElementById('w');
  fetch('/api/words', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word: input.value })
  }).then(function (r) { return r.json(); }).then(function (d) {
    document.getElementById('msg').textContent = 'Added "' + d.word + '".';
    input.value = '';
  });
  return false;
}

var stream = new EventSource('/api/stream');
stream.onmessage = function (ev) { render(JSON.parse(ev.data)); };
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    subscribers.add(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/words') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const frame = snapshot();
    const word = submit(parsed.word, req.socket.remoteAddress);
    broadcast(frame);
    return json(res, 200, { word });
  }

  if (url.pathname === '/api/words') return json(res, 200, snapshot());
  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    reset();
    return json(res, 200, { ok: true });
  }

  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log(`listening on ${port}`));
}

export { server, subscribers };
