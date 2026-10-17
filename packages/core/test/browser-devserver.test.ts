// A Code session's dev server in the agent browser (FR-097, FR-067; docs/10 §7, docs/12 §4.2 and
// §8): the grant lets the session thread's browser reach exactly the dev server's 127.0.0.1 port
// (the egress proxy's grant, local binding in the browser's proxy policy, its own guards) without
// `browser.allowLocalSites`, the opener shows it as the user's recorded action, other hosts and
// ports keep their rules, and revoking closes it again. Where bubblewrap works, the whole chain:
// a dev server in a sandbox without network, the bridge, the proxy and the browser's grant.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BwrapSandbox,
  EgressProxyService,
  FORWARDER_NODE,
  browserDevServerGrant,
  browserDevServerOpener,
  findOnPath,
  seccompArch,
  type EgressPolicy,
  type EgressProxy,
} from '../src/index.ts';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import { makeCodeM6Env, until, type CodeM6Env } from './code-m6-env.ts';

let dir: string;
let dev: Server;
let other: Server;
let devPort: number;
let otherPort: number;

const listen = (s: Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-bdev-'));
  dev = createServer((q, res) => res.end(`dev ${q.url}`));
  other = createServer((_q, res) => res.end('other local service'));
  devPort = await listen(dev);
  otherPort = await listen(other);
});
afterAll(async () => {
  for (const s of [dev, other]) await new Promise((r) => s.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** One request the way Chromium sends it through its proxy session (absolute URL, token). */
function viaProxy(
  proxyServer: string,
  target: string,
): Promise<{ status: number; body: string; cause: string | null }> {
  const p = new URL(proxyServer);
  const auth = Buffer.from(`${p.username}:${p.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: p.hostname,
        port: Number(p.port),
        method: 'GET',
        path: target,
        agent: false,
        headers: { host: new URL(target).host, 'proxy-authorization': `Basic ${auth}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            cause: (res.headers['x-nova-block-cause'] as string | undefined) ?? null,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface Proxied {
  proxy: EgressProxyService;
  egress: EgressProxy;
  opened: { scope: { kind: string; id: string }; policy: EgressPolicy }[];
}

/** The real egress proxy, with the sessions the browser opens recorded. */
function proxied(sub: string): Proxied {
  const proxy = new EgressProxyService({ socketDir: join(dir, sub) });
  const opened: Proxied['opened'] = [];
  return {
    proxy,
    opened,
    egress: {
      open: (input) => {
        opened.push({ scope: input.scope, policy: input.policy });
        return proxy.open(input);
      },
      grantDevServer: (input) => proxy.grantDevServer(input),
    },
  };
}

describe('dev servers in the agent browser', () => {
  let env: BrowserEnv;
  let px: Proxied;
  let devUrl: string;
  const proxyServer = () => env.driver.launches.at(-1)!.proxy!.server;
  const input = { accountId: ACCOUNT, sessionId: 'sess-1', threadId: THREAD, serverId: 'srv-1' };

  beforeEach(async () => {
    px = proxied(`p${Date.now()}`);
    env = await makeBrowserEnv({ requireEgress: true, egress: px.egress });
    devUrl = `http://127.0.0.1:${devPort}/`;
    env.driver.pages.set(devUrl, { title: 'Dev', text: 'my app', elements: [] });
    env.driver.pages.set('https://a.example/', { title: 'A', text: 'a', elements: [] });
    await env.service.sites.put(ACCOUNT, {
      pattern: 'a.example',
      access: 'allow',
      level: 'always_allow',
    });
  });
  afterEach(async () => {
    await env.close();
    await px.proxy.close();
  });

  it("grants the session thread's browser exactly the dev server's host and port", async () => {
    const grant = browserDevServerGrant(env.service);
    const open = browserDevServerOpener(env.service);
    const g = await grant({ ...input, host: '127.0.0.1', port: devPort });
    expect(g?.url).toBeNull();
    await open({ ...input, url: devUrl });
    // The thread's own computer, local binding in its proxy policy; the global setting stays off.
    expect(px.opened).toHaveLength(1);
    expect(px.opened[0]).toMatchObject({
      scope: { kind: 'sandbox', id: `browser:thread-${THREAD}` },
      policy: { allowLocalBinding: true },
    });
    expect(env.settings['browser.allowLocalSites']).toBe(false);
    expect(env.driver.log).toContain(`goto ${devUrl}`);
    const s = env.service.session(ACCOUNT, `thread-${THREAD}`)!;
    expect(s.url).toBe(devUrl);
    // Recorded as the user's action in the browser's trace, with the navigation event.
    const rows = env.db.raw
      .prepare('SELECT tool, action, target, host, result, thread_id, call_id FROM browser_action')
      .all();
    expect(rows).toEqual([
      {
        tool: 'devserver.open',
        action: 'navigate',
        target: `127.0.0.1:${devPort}`,
        host: '127.0.0.1',
        result: 'ok',
        thread_id: THREAD,
        call_id: expect.stringMatching(/^devserver:/) as unknown,
      },
    ]);
    expect(env.events.events.find((x) => x.name === 'browser.navigated')?.payload).toMatchObject({
      computerId: `thread-${THREAD}`,
      allowed: true,
    });
    // Through the browser's proxy session: the dev server answers; another local port does not.
    expect(await viaProxy(proxyServer(), `${devUrl}x`)).toMatchObject({
      status: 200,
      body: 'dev /x',
    });
    expect(await viaProxy(proxyServer(), `http://127.0.0.1:${otherPort}/`)).toMatchObject({
      status: 403,
      cause: 'allowlist',
    });
    // The browser's own guards: that host and port only.
    expect(s.allowsNavigation(devUrl)).toBe(true);
    expect(s.allowsRequest(`${devUrl}assets/app.js`)).toBe(true);
    expect(s.allowsNavigation(`http://127.0.0.1:${otherPort}/`)).toBe(false);
    expect(s.allowsNavigation(`http://localhost:${devPort}/`)).toBe(false);
    expect(s.allowsNavigation('https://unknown.example/')).toBe(false);
    expect(s.allowsRequest('https://cdn.unknown.example/lib.js')).toBe(false);
    // The agent opens it (and its pages) without the new-site prompt; other local ports are refused.
    expect((await env.service.navigate(env.call({ mode: 'code' }), `${devUrl}about`)).ok).toBe(
      true,
    );
    expect(env.approvals()).toEqual([]);
    expect(
      await env.service.navigate(env.call({ mode: 'code' }), `http://127.0.0.1:${otherPort}/`),
    ).toMatchObject({ ok: false, error: { code: 'blocked_site' } });
    // Revoked: the proxy, the guards and the opener close again.
    await g!.revoke();
    expect(await viaProxy(proxyServer(), devUrl)).toMatchObject({ status: 403 });
    expect(s.allowsNavigation(devUrl)).toBe(false);
    await expect(open({ ...input, url: devUrl })).rejects.toThrow(/not_granted/);
    expect(await env.service.navigate(env.call({ mode: 'code' }), devUrl)).toMatchObject({
      ok: false,
      error: { code: 'blocked_site' },
    });
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['browser.devserver.granted', 'browser.devserver.revoked']),
    );
  });

  it("restarts a running browser with local binding and its cookies, on the resolver's computer", async () => {
    env.service.useComputerResolver(() => Promise.resolve('agent-pc'));
    expect((await env.service.navigate(env.call(), 'https://a.example/')).ok).toBe(true);
    expect(px.opened[0]).toMatchObject({
      scope: { id: 'browser:agent-pc' },
      policy: { allowLocalBinding: false },
    });
    env.driver.current.storage = {
      cookies: [{ name: 'sid', value: 'x', domain: 'a.example' }],
      origins: [],
    };
    const grant = browserDevServerGrant(env.service);
    const g1 = await grant({ ...input, host: '127.0.0.1', port: devPort });
    const g2 = await grant({ ...input, serverId: 'srv-2', host: '127.0.0.1', port: devPort });
    // A grant alone does not restart a browser in use; opening the server does.
    expect(px.opened).toHaveLength(1);
    await browserDevServerOpener(env.service)({ ...input, url: devUrl });
    expect(px.opened).toHaveLength(2);
    expect(px.opened[1]).toMatchObject({
      scope: { kind: 'sandbox', id: 'browser:agent-pc' },
      policy: { allowLocalBinding: true },
    });
    expect(env.driver.sessions[0]!.closed).toBe(true);
    expect(env.driver.launches[1]!.storageState?.cookies).toEqual([
      { name: 'sid', value: 'x', domain: 'a.example' },
    ]);
    expect(env.service.session(ACCOUNT, 'agent-pc')?.url).toBe(devUrl);
    // Two grants of one host and port: the second still holds after the first is revoked.
    await g1!.revoke();
    await g1!.revoke();
    expect(await viaProxy(proxyServer(), devUrl)).toMatchObject({ status: 200 });
    await g2!.revoke();
    expect(await viaProxy(proxyServer(), devUrl)).toMatchObject({ status: 403 });
  });

  it("lets the user's takeover open it, and refuses anything that is not a granted dev server", async () => {
    const g = await env.service.grantDevServer({
      accountId: ACCOUNT,
      computerId: `thread-${THREAD}`,
      host: '127.0.0.1',
      port: devPort,
    });
    const ctl = env.service.controllerFor(ACCOUNT, `thread-${THREAD}`);
    await ctl.pause('user');
    const r = await ctl.act({ kind: 'navigate', url: devUrl }, new AbortController().signal);
    expect(r.ok).toBe(true);
    ctl.resume();
    // Grants cover loopback dev servers only.
    for (const host of ['example.com', '10.0.0.5', '192.168.1.2'])
      await expect(
        env.service.grantDevServer({
          accountId: ACCOUNT,
          computerId: `thread-${THREAD}`,
          host,
          port: 3000,
        }),
      ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      env.service.grantDevServer({
        accountId: ACCOUNT,
        computerId: `thread-${THREAD}`,
        host: 'localhost',
        port: 0,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    // The opener opens only a granted dev server's own address.
    const open = (url: string) =>
      env.service.openDevServer({ accountId: ACCOUNT, threadId: THREAD, url });
    expect(await open('https://a.example/')).toMatchObject({ error: { code: 'not_granted' } });
    expect(await open(`http://127.0.0.1:${otherPort}/`)).toMatchObject({
      error: { code: 'not_granted' },
    });
    expect(await open(`ftp://127.0.0.1:${devPort}/`)).toMatchObject({
      error: { code: 'invalid_arguments' },
    });
    expect(await open(`http://u:p@127.0.0.1:${devPort}/`)).toMatchObject({
      error: { code: 'invalid_arguments' },
    });
    // Another thread's browser has no grant.
    expect(
      await env.service.openDevServer({ accountId: ACCOUNT, threadId: 'other', url: devUrl }),
    ).toMatchObject({ error: { code: 'not_granted' } });
    // The blocked list still wins over a grant.
    await env.service.sites.put(ACCOUNT, { pattern: '127.0.0.1', access: 'block' });
    expect(await open(devUrl)).toMatchObject({ error: { code: 'blocked_site' } });
    expect(env.service.session(ACCOUNT, `thread-${THREAD}`)!.allowsNavigation(devUrl)).toBe(false);
    await g.revoke();
  });
});

// ---- the whole chain, where bubblewrap works -------------------------------------------------------

const BWRAP = findOnPath('bwrap');
let bwrapWorks = false;
if (BWRAP && process.platform === 'linux' && seccompArch()) {
  try {
    execFileSync(BWRAP, ['--unshare-all', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
    bwrapWorks = true;
  } catch {
    bwrapWorks = false;
  }
}

describe.runIf(bwrapWorks)('a Code dev server previewed in the agent browser (integration)', () => {
  let e: CodeM6Env | null = null;
  let env: BrowserEnv | null = null;
  let px: Proxied | null = null;
  afterEach(async () => {
    await e?.close();
    await env?.close();
    await px?.proxy.close();
    e = null;
    env = null;
    px = null;
  });

  it('runs the server without network, bridges it, grants the browser and opens it', async () => {
    e = await makeCodeM6Env({ sandbox: new BwrapSandbox({ bin: BWRAP! }) });
    px = proxied('chain');
    env = await makeBrowserEnv({ requireEgress: true, egress: px.egress });
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          {
            name: 'web',
            // The Hub's Node, mounted for the bridge's forwarder, serves on the sandbox's loopback.
            command: `${FORWARDER_NODE} -e "require('http').createServer((q,s)=>s.end('from the sandbox '+q.url)).listen(+process.env.PORT,'127.0.0.1')"`,
            port: 5173,
          },
        ],
      }),
    );
    e.devServers.useGrant(browserDevServerGrant(env.service));
    e.devServers.useOpener(browserDevServerOpener(env.service));
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const v = await e.devServers.start(ACCOUNT, s.id, {}, 'user');
    expect(v.port).toBe(5173);
    const hostPort = Number(new URL(v.url!).port);
    expect(hostPort).not.toBe(5173);
    const b = env;
    await until(() => b.driver.log.includes(`goto ${v.url}`), 15_000);
    expect(px.opened.at(-1)).toMatchObject({
      scope: { id: `browser:thread-${s.threadId}` },
      policy: { allowLocalBinding: true },
    });
    // What Chromium fetches through its proxy session reaches the server inside the sandbox.
    const server = env.driver.launches.at(-1)!.proxy!.server;
    expect(await viaProxy(server, `${v.url}page`)).toMatchObject({
      status: 200,
      body: 'from the sandbox /page',
    });
    await e.devServers.stop(ACCOUNT, s.id, v.id, 'user');
    // Revoked with the server: the proxy refuses it, and the bridge is gone.
    expect(await viaProxy(server, v.url!)).toMatchObject({ status: 403 });
  }, 40_000);
});
