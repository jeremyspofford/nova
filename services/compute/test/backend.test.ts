// The local backend adapter and the egress guard (FR-126: the node talks only to the Hub and its
// backend), plus the Hub client's error mapping.
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect } from '@nova/providers';
import {
  Backend,
  HubClient,
  HubError,
  guardedFetch,
  startFakeBackend,
  type FakeBackend,
} from '../src/index.ts';

let fake: FakeBackend;
beforeEach(async () => {
  fake = await startFakeBackend({ models: ['m2', 'm1'], delayMs: 1 });
});
afterEach(() => fake.close());

describe('guardedFetch', () => {
  it('refuses any origin outside the allowed set', async () => {
    const f = guardedFetch([fake.url]);
    const ok = await f(`${fake.url}/v1/models`);
    expect(ok.status).toBe(200);
    await expect(f('http://192.0.2.1:9/x')).rejects.toThrow(/refused/);
    await expect(f('not a url')).rejects.toThrow(/invalid URL/);
    expect((await f(new URL(`${fake.url}/api/tags`))).status).toBe(200);
    expect((await f(new Request(`${fake.url}/api/tags`))).status).toBe(200);
  });

  it('never follows redirects', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(302, { location: `${fake.url}/v1/models` }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(guardedFetch([url, fake.url])(`${url}/`)).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Backend', () => {
  it('lists models from an Ollama-style or llama.cpp-style server', async () => {
    expect(await new Backend({ url: fake.url, kind: 'ollama' }).models()).toEqual(['m1', 'm2']);
    expect(await new Backend({ url: `${fake.url}/`, kind: 'llamacpp' }).models()).toEqual([
      'm1',
      'm2',
    ]);
    expect(
      await new Backend({ url: `${fake.url}/v1`, kind: 'openai_compatible' }).models(),
    ).toEqual(['m1', 'm2']);
  });

  it('streams a chat through the backend', async () => {
    const backend = new Backend({ url: fake.url, kind: 'llamacpp' });
    const out = await collect(
      backend.stream({
        model: 'm1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        signal: new AbortController().signal,
      }),
    );
    expect(out.text).toBe('Echo: ping');
    expect(out.stop).toBe('end');
    expect(fake.requests.at(-1)?.path).toBe('/v1/chat/completions');
  });

  it('reports an unreachable backend', async () => {
    await fake.close();
    await expect(
      new Backend({ url: fake.url, kind: 'llamacpp', connectTimeoutMs: 500 }).models(),
    ).rejects.toThrow();
  });
});

describe('HubClient', () => {
  it('maps Hub errors and network failures', async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === '/node/v1/heartbeat') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'auth_missing', message: 'revoked' } }));
        return;
      }
      res.writeHead(500).end('oops');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const hub = new HubClient({ hubUrl: url });
    expect(hub.hubUrl).toBe(url.slice(0, -1));
    const e1 = await hub
      .heartbeat('c', { load: { running: 0, queued: 0 } })
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(HubError);
    expect(e1).toMatchObject({ status: 401, code: 'auth_missing', message: 'revoked' });
    const e2 = await hub
      .syncModels('c', { capability: {}, signature: 's' })
      .catch((e: unknown) => e);
    expect(e2).toMatchObject({ status: 500, code: 'server_error' });
    await new Promise<void>((r) => server.close(() => r()));
    const e3 = await hub
      .heartbeat('c', { load: { running: 0, queued: 0 } })
      .catch((e: unknown) => e);
    expect(e3).toMatchObject({ status: 0, code: 'network' });
    expect(() => new HubClient({ hubUrl: 'ftp://x' })).toThrow(TypeError);
    expect(() => new HubClient({ hubUrl: 'http://u:p@x' })).toThrow(TypeError);
  });
});
