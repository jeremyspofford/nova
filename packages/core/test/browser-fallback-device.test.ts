// The device launcher (FR-209; ADR-096 D7) against a fake novad on 127.0.0.1: launch and close
// with the management token, the DevTools relay (the token and the session's path go only to the
// device, one connection, a wrong path refused), a session path novad must not change, TLS-only
// devices without the TLS connector, and `bridge/call` (D8: echo, the extension's refusal,
// `bridge_offline`). Where a Chromium can start (the Playwright container, CI), the fake novad
// runs a real headless Chromium with --remote-debugging-port=0 and passes the DevTools WebSocket
// through, and the agent browser continues a blocked site on it end to end; elsewhere that part
// is skipped with the reason, like browser-chromium.test.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { managementTokenRef, type ManagedDevice } from '../src/index.ts';
import {
  DeviceBrowserDriver,
  LocalFallbackService,
  closeOrphanDeviceSessions,
  PlaywrightDriver,
  deviceBrowserLink,
  deviceCdpPath,
  startCdpRelay,
  type DriverLaunchOptions,
  type DriverSession,
} from '../src/browser/index.ts';
import { ACCOUNT, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';

const DEVICE = 'dev-laptop';
const TOKEN = 'nvm_management_token_for_tests';

interface Upgrade {
  path: string;
  authorization: string | undefined;
  host: string | undefined;
  key: string | undefined;
}

/** A fake novad: the browser routes, the DevTools pass-through and the bridge call (D7, D8). */
class FakeNovad {
  server!: Server;
  port = 0;
  readonly launches: Record<string, unknown>[] = [];
  readonly closes: Record<string, unknown>[] = [];
  readonly calls: Record<string, unknown>[] = [];
  readonly upgrades: Upgrade[] = [];
  /** Answer launch with another session's path (novad must not redirect the relay). */
  wrongPath = false;
  bridge: 'echo' | 'refuse' | 'offline' = 'echo';
  /** Run a real Chromium per session (where one starts). */
  chromium: string | null = null;
  readonly browsers = new Map<
    string,
    { proc: ChildProcess; dir: string; port: number; path: string }
  >();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.#route(
          req,
          chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
            : {},
        ).then(([status, body]) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        });
      });
    });
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.#upgrade(req, socket, head),
    );
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }

  async #route(req: IncomingMessage, body: Record<string, unknown>): Promise<[number, unknown]> {
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return [401, { error: { code: 'auth_missing', message: 'bad token' } }];
    if (req.url === '/agent/v1/browser/launch') {
      this.launches.push(body);
      const sid = String(body.sessionId);
      if (this.chromium) await this.#launchChromium(sid);
      return [
        200,
        { sessionId: sid, cdpPath: this.wrongPath ? deviceCdpPath('other') : deviceCdpPath(sid) },
      ];
    }
    if (req.url === '/agent/v1/browser/close') {
      this.closes.push(body);
      const b = this.browsers.get(String(body.sessionId));
      if (b) {
        b.proc.kill('SIGKILL');
        rmSync(b.dir, { recursive: true, force: true });
        this.browsers.delete(String(body.sessionId));
      }
      return [200, { closed: true, egress: { allowed: 3, refused: 1 } }];
    }
    if (req.url === '/agent/v1/browser/list') {
      const closed = new Set(this.closes.map((c) => String(c.sessionId)));
      return [
        200,
        {
          sessions: this.launches
            .map((l) => ({ sessionId: String(l.sessionId) }))
            .filter((x) => !closed.has(x.sessionId)),
          max: 2,
        },
      ];
    }
    if (req.url === '/agent/v1/bridge/call') {
      this.calls.push(body);
      if (this.bridge === 'offline')
        return [
          409,
          {
            error: { code: 'conflict', message: 'no host', details: { reason: 'bridge_offline' } },
          },
        ];
      if (this.bridge === 'refuse')
        return [
          200,
          { error: { code: 'host_not_permitted', message: 'not permitted in the browser' } },
        ];
      return [200, { result: { echo: body.method, params: body.params } }];
    }
    return [404, {}];
  }

  async #launchChromium(sid: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'nova-fake-novad-'));
    const proc = spawn(
      this.chromium!,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        // The test site has a name, as a real site would (novad's filter refuses addresses).
        '--host-resolver-rules=MAP shop.test 127.0.0.1',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const file = join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
    this.browsers.set(sid, { proc, dir, port: Number(port), path: path! });
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrades.push({
      path: req.url ?? '',
      authorization: req.headers.authorization,
      host: req.headers.host,
      key: req.headers['sec-websocket-key'],
    });
    const sid = (req.url ?? '').split('/').pop() ?? '';
    if (
      req.headers.authorization !== `Bearer ${TOKEN}` ||
      !req.url?.startsWith('/agent/v1/browser/cdp/')
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const b = this.browsers.get(sid);
    if (!b) {
      // The stub: accept and echo the bytes back.
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      if (head.length) socket.write(head);
      socket.pipe(socket);
      return;
    }
    // novad's pass-through: the same upgrade to Chromium's browser path, then bytes both ways.
    const up = connect(b.port, '127.0.0.1', () => {
      let r = `GET ${b.path} HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\n`;
      for (const h of [
        'upgrade',
        'connection',
        'sec-websocket-key',
        'sec-websocket-version',
        'sec-websocket-extensions',
      ])
        if (req.headers[h]) r += `${h}: ${String(req.headers[h])}\r\n`;
      up.write(`${r}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
    socket.on('close', end);
  }

  async stop(): Promise<void> {
    for (const b of this.browsers.values()) {
      b.proc.kill('SIGKILL');
      rmSync(b.dir, { recursive: true, force: true });
    }
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let novad: FakeNovad;
let secrets: MemorySecretStore;
let endpoint: string;

const devices = {
  device: () =>
    Promise.resolve({
      row: { id: DEVICE, status: 'active', publicKey: 'pinned-key' },
      endpoint,
      mgmt: {},
      document: {},
    } as unknown as ManagedDevice),
};

function link(over: Partial<Parameters<typeof deviceBrowserLink>[0]> = {}) {
  return deviceBrowserLink({ devices, secrets, ...over });
}

/** Do the client side of a WebSocket upgrade by hand; returns the socket and the answer head. */
async function rawUpgrade(url: string): Promise<{ socket: Socket; head: string }> {
  const u = new URL(url);
  const socket = connect(Number(u.port), u.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.off('error', reject);
      // Later resets (the other side closing) are expected here.
      socket.on('error', () => undefined);
      resolve();
    });
    socket.once('error', reject);
  });
  socket.write(
    `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nUser-Agent: leaks\r\n\r\n',
  );
  const head = await new Promise<string>((resolve) => {
    let buf = '';
    const on = (c: Buffer) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        socket.off('data', on);
        resolve(buf);
      }
    };
    socket.on('data', on);
    socket.once('close', () => resolve(buf));
  });
  return { socket, head };
}

beforeEach(async () => {
  novad = new FakeNovad();
  await novad.start();
  endpoint = `http://127.0.0.1:${novad.port}`;
  secrets = new MemorySecretStore();
  await secrets.put(managementTokenRef(DEVICE), TOKEN);
});

afterEach(async () => {
  await novad.stop();
});

describe('the DevTools relay', () => {
  it('passes one upgrade to the session path with the token, and echoes bytes', async () => {
    const relay = await startCdpRelay({
      cdpPath: deviceCdpPath('s1'),
      open: () => link().open({ accountId: ACCOUNT, deviceId: DEVICE }),
    });
    expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}$/);
    // Another path is refused, and so is a second connection.
    const wrong = await rawUpgrade(relay.url.replace(/\/[^/]+$/, '/guess'));
    expect(wrong.head).toMatch(/^HTTP\/1\.1 404/);
    const { socket, head } = await rawUpgrade(relay.url);
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    expect(novad.upgrades).toEqual([
      {
        path: '/agent/v1/browser/cdp/s1',
        authorization: `Bearer ${TOKEN}`,
        host: `127.0.0.1:${novad.port}`,
        key: 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    ]);
    const echoed = new Promise<string>((r) => socket.once('data', (c: Buffer) => r(c.toString())));
    socket.write('ping');
    expect(await echoed).toBe('ping');
    const second = await rawUpgrade(relay.url);
    expect(second.head).toMatch(/^HTTP\/1\.1 404/);
    socket.destroy();
    second.socket.destroy();
    wrong.socket.destroy();
    await relay.close();
  });

  it('answers 502 when the device cannot be reached', async () => {
    const relay = await startCdpRelay({
      cdpPath: deviceCdpPath('s1'),
      open: () => Promise.reject(new Error('down')),
    });
    const { socket, head } = await rawUpgrade(relay.url);
    expect(head).toMatch(/^HTTP\/1\.1 502/);
    socket.destroy();
    await relay.close();
  });
});

describe('the device launcher', () => {
  const opts = {} as DriverLaunchOptions;
  const stubSession = () => {
    let closed = 0;
    const s = { url: () => 'about:blank', close: () => (closed++, Promise.resolve()) };
    return { s: s as unknown as DriverSession, closed: () => closed };
  };

  it('launches on the device, connects through the relay, and closes both', async () => {
    const egress: unknown[] = [];
    const stub = stubSession();
    let wsUrl = '';
    const driver = new DeviceBrowserDriver({
      link: link(),
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      grantee: { kind: 'agent', id: 'agent-1' },
      allowHosts: ['shop.example', '*.shop.example'],
      connect: async (url, o) => {
        wsUrl = url;
        // Downloads would land on the device: off (review #8).
        expect(o.acceptDownloads).toBe(false);
        // What Playwright's connectOverCDP does first: the upgrade through the relay.
        const { socket, head } = await rawUpgrade(url);
        expect(head).toMatch(/^HTTP\/1\.1 101/);
        socket.destroy();
        return stub.s;
      },
      onClosed: (e) => egress.push(e),
    });
    expect(await driver.probe()).toMatchObject({ ok: true });
    const session = await driver.launch(opts);
    expect(novad.launches[0]).toMatchObject({
      grantee: { kind: 'agent', id: 'agent-1' },
      allowHosts: ['shop.example', '*.shop.example'],
      headless: true,
    });
    const sid = String(novad.launches[0]!.sessionId);
    expect(novad.upgrades[0]?.path).toBe(deviceCdpPath(sid));
    expect(wsUrl).not.toContain(TOKEN);
    expect(session.url()).toBe('about:blank');
    await session.close();
    await session.close();
    expect(stub.closed()).toBe(1);
    expect(novad.closes).toEqual([{ sessionId: sid }]);
    expect(egress).toEqual([{ allowed: 3, refused: 1 }]);
    // The relay is gone with the session: nothing upgrades there any more.
    const after = await rawUpgrade(wsUrl).catch(() => null);
    expect(after?.head ?? '').not.toMatch(/101/);
    after?.socket.destroy();
  });

  it('refuses a session path novad was not asked for, and closes that session', async () => {
    novad.wrongPath = true;
    const driver = new DeviceBrowserDriver({
      link: link(),
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      grantee: { kind: 'agent', id: 'a' },
      allowHosts: [],
      connect: () => Promise.reject(new Error('never')),
    });
    await expect(driver.launch(opts)).rejects.toMatchObject({ code: 'server_error' });
    expect(novad.closes).toHaveLength(1);
  });

  it('closes the device session when the connection fails', async () => {
    const driver = new DeviceBrowserDriver({
      link: link(),
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      grantee: { kind: 'agent', id: 'a' },
      allowHosts: [],
      connect: () => Promise.reject(new Error('handshake failed')),
    });
    await expect(driver.launch(opts)).rejects.toThrow('handshake failed');
    expect(novad.closes).toHaveLength(1);
  });

  it('never reaches an https device without the TLS connector, nor with a wrong token', async () => {
    endpoint = `https://127.0.0.1:${novad.port}`;
    await expect(link().open({ accountId: ACCOUNT, deviceId: DEVICE })).rejects.toMatchObject({
      code: 'capability_missing',
    });
    let asked: { url: string; deviceId: string } | null = null;
    const tls = link({
      connectTls: (url, deviceId) => {
        asked = { url: url.href, deviceId };
        return Promise.reject(new Error('no certificate in this test'));
      },
    });
    await expect(tls.open({ accountId: ACCOUNT, deviceId: DEVICE })).rejects.toThrow(
      'no certificate',
    );
    expect(asked).toEqual({ url: `${endpoint}/`, deviceId: DEVICE });
    endpoint = `http://127.0.0.1:${novad.port}`;
    await secrets.put(managementTokenRef(DEVICE), 'wrong');
    await expect(
      link().launch({
        accountId: ACCOUNT,
        deviceId: DEVICE,
        sessionId: 's',
        grantee: { kind: 'agent', id: 'a' },
        allowHosts: [],
        headless: true,
      }),
    ).rejects.toMatchObject({ code: 'auth_missing' });
  });

  it('refuses a device that is not active', async () => {
    const offline = deviceBrowserLink({
      devices: {
        device: () =>
          Promise.resolve({
            row: { id: DEVICE, status: 'unreachable', publicKey: 'k' },
            endpoint: null,
          } as unknown as ManagedDevice),
      },
      secrets,
    });
    await expect(offline.open({ accountId: ACCOUNT, deviceId: DEVICE })).rejects.toMatchObject({
      code: 'node_unavailable',
    });
  });
});

describe('sessions left on a device (review #7)', () => {
  it('closes the sessions the Hub does not know, and leaves its own', async () => {
    const live = new Set<string>();
    const l = link();
    const stub = {
      url: () => 'about:blank',
      close: () => Promise.resolve(),
    } as unknown as DriverSession;
    const driver = new DeviceBrowserDriver({
      link: l,
      accountId: ACCOUNT,
      deviceId: DEVICE,
      deviceName: 'Laptop',
      grantee: { kind: 'agent', id: 'a' },
      allowHosts: ['shop.example'],
      connect: () => Promise.resolve(stub),
      live,
    });
    const mine = await driver.launch({} as DriverLaunchOptions);
    // A session a previous Hub left behind.
    await l.launch({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      sessionId: 'orphan-1',
      grantee: { kind: 'agent', id: 'a' },
      allowHosts: ['shop.example'],
      headless: true,
    });
    const closedNow: string[] = [];
    const n = await closeOrphanDeviceSessions({
      link: l,
      targets: [
        { accountId: ACCOUNT, deviceId: DEVICE },
        { accountId: ACCOUNT, deviceId: 'unreachable' },
      ],
      live,
      onClosed: (t) => closedNow.push(t.sessionId),
    });
    expect(n).toBe(1);
    expect(closedNow).toEqual(['orphan-1']);
    expect(live.size).toBe(1);
    await mine.close();
    expect(live.size).toBe(0);
  });
});

describe('the bridge call (D8)', () => {
  const call = (l = link()) =>
    l.bridgeCall({
      accountId: ACCOUNT,
      deviceId: DEVICE,
      method: 'tabs.list',
      params: { x: 1 },
      timeoutMs: 1_000,
    });

  it('passes the method and answers the result, the refusal or bridge_offline', async () => {
    expect(await call()).toEqual({ result: { echo: 'tabs.list', params: { x: 1 } } });
    expect(novad.calls[0]).toEqual({ method: 'tabs.list', params: { x: 1 }, timeoutMs: 1_000 });
    novad.bridge = 'refuse';
    expect(await call()).toEqual({
      error: { code: 'host_not_permitted', message: 'not permitted in the browser' },
    });
    novad.bridge = 'offline';
    await expect(call()).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'bridge_offline' },
    });
  });

  it('is node_unavailable when the device does not answer', async () => {
    await novad.stop();
    await expect(call()).rejects.toMatchObject({ code: 'node_unavailable' });
    novad = new FakeNovad();
    await novad.start();
  });
});

// ---- a real Chromium behind the fake novad (skipped where none starts) -------------------------

const playwright = new PlaywrightDriver();
const probe = await playwright.probe(process.env.NOVA_BROWSER_EXECUTABLE ?? null);
const chromiumPath = await (async () => {
  if (!probe.ok) return null;
  if (process.env.NOVA_BROWSER_EXECUTABLE) return process.env.NOVA_BROWSER_EXECUTABLE;
  const pw = await import('playwright-core');
  return pw.chromium.executablePath();
})();

it('reports whether the device browser test can run here', () => {
  if (!probe.ok) console.warn(`device browser over Chromium skipped: ${probe.detail}`);
  expect(probe.detail.length).toBeGreaterThan(0);
});

describe.skipIf(!probe.ok)('the agent browser on a device (real Chromium)', () => {
  let site: Server;
  let base: string;
  let env: BrowserEnv;

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><title>Device shop</title><p>Served to the device browser</p><a href="/cart">Cart</a>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://shop.test:${(site.address() as { port: number }).port}/`;
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  });

  beforeEach(async () => {
    novad.chromium = chromiumPath;
    env = await makeBrowserEnv({ computerFor: () => Promise.resolve('comp-1') });
    await env.service.sites.put(ACCOUNT, {
      pattern: 'shop.test',
      access: 'allow',
      level: 'always_allow',
    });
    // The agent's own browser is refused by the site.
    env.driver.pages.set(base, {
      title: 'Access Denied',
      text: 'You have been blocked',
      elements: [],
      status: 403,
    });
    const fallback = new LocalFallbackService({
      db: env.db,
      events: env.events,
      setting: () => Promise.resolve(true as never),
      audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
      requests: {
        ask: (input) =>
          Promise.resolve({
            status: 'resolved',
            result: { choice: (input.payload as { choices: string[] }).choices[0] },
            by: 'owner',
          }),
      },
      resolver: {
        target: () =>
          Promise.resolve({
            ok: true,
            scope: { kind: 'agent', ref: 'agent-1' },
            deviceId: DEVICE,
            deviceName: 'Laptop',
          }),
      },
      deviceDriver: (input) =>
        new DeviceBrowserDriver({
          link: link(),
          accountId: input.accountId,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          grantee: { kind: 'agent', id: input.agentId ?? 'none' },
          allowHosts: input.allowHosts,
          connect: (url, o) => playwright.connectOverCdp(url, o),
          onClosed: input.onClosed,
        }),
    });
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status, created_at, updated_at)
         VALUES (?, ?, 'Laptop', 'client', 'fp', 'k', '["client"]', 'active', ?, ?)`,
      )
      .run(DEVICE, ACCOUNT, now, now);
    env.service.useLocalFallback(fallback);
  });

  afterEach(async () => {
    await env.close();
  });

  it('continues the blocked site in Chromium on the device and reads it', async () => {
    const r = await env.service.navigate(env.call(), base);
    expect(r.ok).toBe(true);
    expect(r.ok && (r.content[0] as { text: string }).text).toContain('Device shop');
    const read = await env.service.read(env.call());
    expect(read.ok && (read.content[0] as { text: string }).text).toContain(
      'Served to the device browser',
    );
    const shot = await env.service.screenshot(env.call(), false);
    expect(shot.ok).toBe(true);
    expect(novad.upgrades.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(novad.launches[0]).toMatchObject({ allowHosts: ['shop.test', '*.shop.test'] });
    expect(await env.service.closeSession(ACCOUNT, 'comp-1')).toBe(true);
    expect(novad.closes).toHaveLength(1);
    expect(novad.browsers.size).toBe(0);
  }, 60_000);
});
