import http from 'node:http';
import { shorten, resolve, recordHit, stats } from './store.js';

const port = process.env.PORT || 4310;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/shorten') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const code = shorten(parsed.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, short: `/${code}` }));
    return;
  }

  if (url.pathname.startsWith('/api/stats/')) {
    const code = url.pathname.slice('/api/stats/'.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stats(code)));
    return;
  }

  if (url.pathname !== '/' && url.pathname.length > 1) {
    const code = url.pathname.slice(1);
    const target = resolve(code);
    recordHit(code, req.headers.referer);
    res.writeHead(302, { location: target });
    res.end();
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>shortener</h1>');
});

server.listen(port, () => console.log(`listening on ${port}`));
