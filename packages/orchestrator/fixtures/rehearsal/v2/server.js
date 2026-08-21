import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { shorten, resolve, recordHit, stats } from './store.js';

const port = process.env.PORT || 4310;
const MAX_BODY_BYTES = 8192;

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

const PAGE = `<!doctype html><meta charset="utf-8"><title>Shortener</title>
<style>body{font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem}code{background:#eee;padding:.2rem .4rem}</style>
<h1>URL shortener</h1>
<form onsubmit="go(event)"><input id=u size=40 placeholder="https://example.com"><button>Shorten</button></form>
<p id=out></p>
<script>
async function go(e){e.preventDefault();
 const r=await fetch('/api/shorten',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:u.value})});
 const d=await r.json();
 out.innerHTML = r.ok ? '<a href="/'+d.code+'">/'+d.code+'</a> &middot; <a href="/api/stats/'+d.code+'">stats</a>' : 'Error: '+d.error;
}
</script>`;

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad request line' });
  }

  if (req.method === 'POST' && url.pathname === '/api/shorten') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: `body must be valid JSON (${err.message})` });
    }
    try {
      const code = shorten(payload?.url);
      return json(res, 201, { code, short: `/${code}`, stats: `/api/stats/${code}` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (url.pathname.startsWith('/api/stats/')) {
    const code = decodeURIComponent(url.pathname.slice('/api/stats/'.length));
    const found = stats(code);
    if (!found) return json(res, 404, { error: `no such code: ${code}` });
    return json(res, 200, found);
  }

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (url.pathname !== '/' && url.pathname.length > 1) {
    const code = decodeURIComponent(url.pathname.slice(1));
    const target = resolve(code);
    if (!target) return json(res, 404, { error: `no such code: ${code}` });
    recordHit(code, req.headers.referer);
    res.writeHead(302, { location: target });
    return res.end();
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

// Only listen when run directly. Importing this from a test must not bind a
// port, or the suite fights itself for it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log(`listening on ${port}`));
}

export { server };
