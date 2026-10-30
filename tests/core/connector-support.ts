// A core behind a console listener on loopback, for the connector tests (M5b). Its connectors are
// started as a hub's are. Home Assistant reconnects within milliseconds here, not a minute.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type CoreOptions } from '../../src/core/index.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(20); v = await read(); }
  return v;
}

export async function bootCore(over: Partial<CoreOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-conn-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, vault: { mode: 'file' }, homeAssistant: { reconnectMs: { first: 30, max: 200 }, timeoutMs: 3000 }, ...over });
  core.start();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, 'console');
    if (!p) return;
    if (await core.handle(req, res, url, p, 'console')) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const get = async (path: string) => (await call('GET', path)).body;
  const stop = async () => { server.closeAllConnections(); server.close(); await core.close(); };
  return { core, home, call, get, stop };
}
