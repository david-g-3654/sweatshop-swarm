import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { shorten, resolve, recordHit, stats, allStats, totalClicks, clicksPerSecond } from './store.js';
import { PAGE } from './dashboard.js';

const port = process.env.PORT || 4310;

const subscribers = new Set();

function snapshot() {
  return { total: totalClicks(), links: allStats(), perSecond: clicksPerSecond(30) };
}

function broadcast(frame) {
  for (const res of subscribers) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

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

  if (req.method === 'POST' && url.pathname === '/api/links') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const code = shorten(parsed.url, parsed.label);
    broadcast(snapshot());
    return json(res, 200, { code, short: `/${code}` });
  }

  if (url.pathname === '/api/stats') return json(res, 200, snapshot());

  if (url.pathname.startsWith('/api/stats/')) {
    const code = url.pathname.slice('/api/stats/'.length);
    return json(res, 200, stats(code));
  }

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (url.pathname !== '/' && url.pathname.length > 1) {
    const code = url.pathname.slice(1);
    const target = resolve(code);
    const frame = snapshot();
    recordHit(code, req.headers.referer);
    broadcast(frame);
    res.writeHead(302, { location: target });
    return res.end();
  }

  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log(`listening on ${port}`));
}

export { server, subscribers };
