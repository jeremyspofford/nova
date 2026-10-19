// FR-128: the shell against a fake novad local runtime that answers like
// services/novad/src/local_runtime.rs, on a 0600 Unix socket and on a loopback address with a token.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalRuntime,
  LocalRuntimeError,
  reasonMessage,
  runtimeEndpoints,
  SYSTEM_SOCKET,
  type RuntimeEndpoint,
} from '../src/local-runtime.ts';

type Mode = 'ok' | 'scope' | 'down' | 'json' | 'error-event' | 'not-found' | 'hang' | 'garbage';
let mode: Mode = 'ok';
const TOKEN = 'nvlr_test-token';
const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

function novadError(res: ServerResponse, status: number, code: string, reason?: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ error: { code, message: code, ...(reason ? { details: { reason } } : {}) } }),
  );
}

function fakeNovad(loopback: boolean) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      if (loopback && req.headers.authorization !== `Bearer ${TOKEN}`)
        return novadError(res, 401, 'token_required');
      if (mode === 'scope') return novadError(res, 403, 'policy_denied', 'scope_missing');
      if (mode === 'down') return novadError(res, 502, 'node_unavailable');
      if (mode === 'not-found') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'model "nope" not found' } }));
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          mode === 'garbage'
            ? 'not json'
            : JSON.stringify({
                object: 'list',
                data: [{ id: 'qwen3:8b' }, { id: 'llama3.2' }, { id: 'qwen3:8b' }, {}],
              }),
        );
      }
      if (mode === 'hang') return; // never answers
      if (mode === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      res.write(': keep-alive\n\n');
      res.write(ev({ choices: [{ delta: { reasoning: 'thinking…' } }] }));
      res.write(ev({ choices: [{ delta: { content: 'Hel' } }] }));
      setTimeout(() => {
        if (mode === 'error-event') {
          res.write(ev({ error: { message: 'out of memory' } }));
          return res.end();
        }
        res.write(`data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\ndata: not-json\n\n`);
        res.end('data: [DONE]\n\n');
      }, 20);
    });
  };
}

const dir = mkdtempSync(join(tmpdir(), 'nova-lr-'));
const socketPath = join(dir, 'runtime.sock');
const tokenFile = join(dir, 'token');
let sockServer: Server;
let tcpServer: Server;
let url = '';

beforeAll(async () => {
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  sockServer = createServer(fakeNovad(false));
  tcpServer = createServer(fakeNovad(true));
  await new Promise<void>((r) => sockServer.listen(socketPath, r));
  chmodSync(socketPath, 0o600);
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(tcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockServer.closeAllConnections();
  tcpServer.closeAllConnections();
  await new Promise((r) => sockServer.close(r));
  await new Promise((r) => tcpServer.close(r));
});

beforeEach(() => {
  mode = 'ok';
  seen.length = 0;
});

const viaSocket = (extra: RuntimeEndpoint[] = []) =>
  new LocalRuntime({ endpoints: () => [...extra, { kind: 'socket', path: socketPath }] });
const viaLoopback = (file = tokenFile) =>
  new LocalRuntime({ endpoints: () => [{ kind: 'loopback', url, tokenFile: file }] });

describe('models()', () => {
  it('lists the models over the socket, skipping places where novad is not', async () => {
    const rt = viaSocket([{ kind: 'socket', path: join(dir, 'absent.sock') }]);
    expect(await rt.models()).toEqual({ ok: true, models: ['llama3.2', 'qwen3:8b'] });
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('sends the token on the loopback address, read from its file by the main process', async () => {
    expect(await viaLoopback().models()).toMatchObject({ ok: true });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const wrong = join(dir, 'wrong-token');
    writeFileSync(wrong, 'nvlr_wrong');
    expect(await viaLoopback(wrong).models()).toMatchObject({ ok: false, reason: 'no_access' });
  });

  it.each([
    ['scope', 'scope_missing', /turn on Local models/],
    ['down', 'no_model_server', /No local model server answers/],
    ['garbage', 'failed', /not readable/],
  ] as const)('refuses with a reason when novad answers %s', async (m, reason, message) => {
    mode = m;
    const res = await viaSocket().models();
    expect(res).toMatchObject({ ok: false, reason, models: [] });
    expect(res.message).toMatch(message);
  });

  it('says when no novad runs here', async () => {
    const none = new LocalRuntime({
      endpoints: () => [
        { kind: 'socket', path: join(dir, 'absent.sock') },
        { kind: 'loopback', url: 'http://127.0.0.1:1', tokenFile },
        { kind: 'loopback', url, tokenFile: join(dir, 'no-token') },
      ],
    });
    expect(await none.models()).toMatchObject({ ok: false, reason: 'no_novad' });
    expect(await new LocalRuntime({ endpoints: () => [] }).models()).toMatchObject({
      reason: 'no_novad',
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'says when novad runs as another user (a socket or token this user may not open)',
    async () => {
      const locked = join(dir, 'locked');
      writeFileSync(locked, TOKEN, { mode: 0o000 });
      expect(await viaLoopback(locked).models()).toMatchObject({ ok: false, reason: 'no_access' });
      const lockedSock = join(dir, 'locked.sock');
      const s = createServer(fakeNovad(false));
      await new Promise<void>((r) => s.listen(lockedSock, r));
      chmodSync(lockedSock, 0o000);
      expect(
        await new LocalRuntime({
          endpoints: () => [{ kind: 'socket', path: lockedSock }],
        }).models(),
      ).toMatchObject({
        ok: false,
        reason: 'no_access',
      });
      await new Promise((r) => s.close(r));
    },
  );
});

describe('chat()', () => {
  it('streams the content as it arrives and leaves the reasoning out', async () => {
    const deltas: string[] = [];
    const res = await viaSocket().chat(
      { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(res).toEqual({ text: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(seen[0]?.url).toBe('/v1/chat/completions');
  });

  it('takes a server that answers in one piece', async () => {
    mode = 'json';
    const deltas: string[] = [];
    expect(
      await viaLoopback().chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, (d) =>
        deltas.push(d),
      ),
    ).toEqual({
      text: 'whole answer',
    });
    expect(deltas).toEqual(['whole answer']);
  });

  it.each([
    ['scope', 'scope_missing'],
    ['down', 'no_model_server'],
    ['not-found', 'failed'],
    ['error-event', 'failed'],
  ] as const)('rejects with a reason when novad answers %s', async (m, reason) => {
    mode = m;
    const err = await viaSocket()
      .chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }, () => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect(err).toMatchObject({ reason });
    if (m === 'not-found') expect((err as Error).message).toContain('model "nope" not found');
    if (m === 'error-event') expect((err as Error).message).toContain('out of memory');
  });

  it('stops when asked, and when the model goes silent', async () => {
    mode = 'hang';
    const ctl = new AbortController();
    const pending = viaSocket().chat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      () => undefined,
      ctl.signal,
    );
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toMatchObject({ reason: 'failed', message: /stopped/ });
    const impatient = new LocalRuntime({
      endpoints: () => [{ kind: 'socket', path: socketPath }],
      timeoutMs: 50,
    });
    await expect(
      impatient.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, () => undefined),
    ).rejects.toMatchObject({ reason: 'failed', message: /in time/ });
  });

  it('stops a runaway answer', async () => {
    const small = new LocalRuntime({
      endpoints: () => [{ kind: 'socket', path: socketPath }],
      maxChars: 3,
    });
    await expect(
      small.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, () => undefined),
    ).rejects.toMatchObject({
      message: /too long/,
    });
  });
});

describe('where the local runtime is', () => {
  const base = { settings: {}, env: {}, platform: 'linux', home: '/home/me', uid: 1000 };

  it("looks in the user's runtime folder, then novad's own socket", () => {
    expect(runtimeEndpoints({ ...base, env: { XDG_RUNTIME_DIR: '/run/user/1000' } })).toEqual([
      { kind: 'socket', path: '/run/user/1000/nova/runtime.sock' },
      { kind: 'socket', path: SYSTEM_SOCKET },
    ]);
    expect(runtimeEndpoints(base)[0]).toEqual({
      kind: 'socket',
      path: '/run/user/1000/nova/runtime.sock',
    });
    expect(runtimeEndpoints({ ...base, uid: null })).toEqual([
      { kind: 'socket', path: SYSTEM_SOCKET },
    ]);
    expect(runtimeEndpoints({ ...base, platform: 'darwin' })[0]).toEqual({
      kind: 'socket',
      path: '/home/me/Library/Application Support/Nova/run/runtime.sock',
    });
    expect(runtimeEndpoints({ ...base, platform: 'win32' })).toEqual([]);
  });

  it('uses the settings (or the environment) instead, and only a loopback address', () => {
    expect(runtimeEndpoints({ ...base, settings: { socket: '/tmp/x.sock' } })).toEqual([
      { kind: 'socket', path: '/tmp/x.sock' },
    ]);
    expect(
      runtimeEndpoints({
        ...base,
        platform: 'win32',
        settings: { url: 'http://127.0.0.1:7421/x', tokenFile: 'C:\\nova\\token' },
      }),
    ).toEqual([{ kind: 'loopback', url: 'http://127.0.0.1:7421', tokenFile: 'C:\\nova\\token' }]);
    expect(
      runtimeEndpoints({ ...base, settings: { url: 'http://192.168.1.2:7421', tokenFile: '/t' } }),
    ).toEqual([]);
    expect(
      runtimeEndpoints({ ...base, settings: { url: 'https://[::1]:7421', tokenFile: '/t' } }),
    ).toEqual([]);
    expect(runtimeEndpoints({ ...base, settings: { url: 'nonsense', tokenFile: '/t' } })).toEqual(
      [],
    );
    expect(
      runtimeEndpoints({
        ...base,
        env: { NOVA_LOCAL_RUNTIME_URL: 'http://[::1]:9', NOVA_LOCAL_RUNTIME_TOKEN_FILE: '/t' },
        settings: { socket: null },
      }),
    ).toEqual([{ kind: 'loopback', url: 'http://[::1]:9', tokenFile: '/t' }]);
  });

  it('has a sentence for every reason', () => {
    for (const r of [
      'no_novad',
      'no_access',
      'scope_missing',
      'no_model_server',
      'failed',
    ] as const)
      expect(reasonMessage(r).length).toBeGreaterThan(20);
  });
});
