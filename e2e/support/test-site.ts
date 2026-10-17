// The local test site for the agent browser (J8): the fixture pages in
// packages/core/test/fixtures/site served over HTTP, with `PORT` in them replaced by the port it
// listens on, and every request recorded, so a journey can tell that a form was never sent.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve('packages/core/test/fixtures/site');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

export interface TestSite {
  /** http://<host>:<port> */
  origin: string;
  host: string;
  port: number;
  /** Every request, oldest first. */
  requests: { method: string; path: string }[];
  /** Requests with this method and path so far. */
  sent(method: string, path: string): number;
  stop(): Promise<void>;
}

/** Listen on `listen`; pages and `origin` name the site by `host` (the same by default). */
export async function startTestSite(listen = '127.0.0.1', host = listen): Promise<TestSite> {
  const requests: { method: string; path: string }[] = [];
  let port = 0;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ method: req.method ?? 'GET', path });
    if (req.method !== 'GET') {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('received');
      return;
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^[a-z]+\.(html|svg|txt)$/.test(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    let body: string;
    try {
      body = readFileSync(join(ROOT, file), 'utf8').replaceAll('PORT', String(port));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, listen, r));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://${host}:${port}`,
    host,
    port,
    requests,
    sent: (method, p) => requests.filter((r) => r.method === method && r.path === p).length,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
