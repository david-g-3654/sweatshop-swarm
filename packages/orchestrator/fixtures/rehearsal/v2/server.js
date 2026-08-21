import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { shorten, resolve, recordHit, stats, allStats, totalClicks, clicksPerSecond } from './store.js';
import { PAGE } from './dashboard.js';

const port = process.env.PORT || 4310;
const MAX_BODY_BYTES = 8192;

/** Every connected dashboard. Entries are removed when the client goes away. */
const subscribers = new Set();

function snapshot() {
  return { total: totalClicks(), links: allStats(), perSecond: clicksPerSecond(30) };
}

/**
 * Push the current numbers to every open dashboard.
 *
 * Always called *after* the write that changed them, and it builds a fresh
 * snapshot each time — a payload captured before the last increment would
 * report stale counts under a burst.
 */
function broadcast() {
  const frame = `data: ${JSON.stringify(snapshot())}\n\n`;
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
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    subscribers.add(res);
    // Without this the set grows for the life of the process — one leaked
    // entry per dashboard anyone ever opened.
    const drop = () => subscribers.delete(res);
    req.on('close', drop);
    req.on('error', drop);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/links') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: `body must be valid JSON (${err.message})` });
    }
    try {
      const code = shorten(payload?.url, payload?.label);
      broadcast();
      return json(res, 201, { code, short: `/${code}`, stats: `/api/stats/${code}` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/stats') return json(res, 200, snapshot());

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
    broadcast();
    res.writeHead(302, { location: target });
    return res.end();
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log(`listening on ${port}`));
}

export { server, subscribers };
