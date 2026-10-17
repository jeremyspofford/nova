// The egress proxy end to end with local servers (FR-102, FR-193, docs/12 §8, ADR-063): allow,
// deny wins, a bare `*` rejected, private addresses blocked with DNS pinning, redirects checked
// as new requests, `limited` methods, HTTPS inspection with the per-Hub CA, 403 cause headers,
// audit entries without full URLs, credential injection only to its host (masked in responses),
// tracking-header stripping, stripping hooks, and the session token on the loopback listener.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CertificateAuthority,
  EgressProxyService,
  classifyAddress,
  type EgressCredential,
  type EgressPolicy,
  type LocalEgressSession,
  type ProxyPolicy,
} from '../src/computers/index.ts';
import type { AuditRecord } from '../src/tools/types.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000e1';
const SECRET = 'sk-test-0123456789abcdef'; // secret-scan: fake

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

let dir: string;
let httpUp: Server;
let httpsUp: Server;
let devUp: Server;
let httpPort: number;
let httpsPort: number;
let devPort: number;
const seen: Seen[] = [];
const upstreamCa = CertificateAuthority.create();
const upCa = new CertificateAuthority(upstreamCa.certPem, upstreamCa.keyPem);
const hubCa = CertificateAuthority.create();

function echo(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: 'http://evil.test/landing' }).end();
      return;
    }
    const body = JSON.stringify({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-echo-auth': String(req.headers.authorization ?? ''),
    });
    res.end(body);
  });
}

beforeAll(async () => {
  httpUp = createServer(echo);
  httpsUp = createHttpsServer(
    { SNICallback: (name, cb) => cb(null, upCa.leaf(name).context) },
    echo,
  );
  devUp = createServer(echo);
  const listen = (s: Server, host: string) =>
    new Promise<number>((r) =>
      s.listen(0, host, () => {
        const a = s.address();
        r(typeof a === 'object' && a ? a.port : 0);
      }),
    );
  httpPort = await listen(httpUp, '127.0.0.1');
  httpsPort = await listen(httpsUp, '127.0.0.1');
  devPort = await listen(devUp, '127.0.0.2');
});
afterAll(async () => {
  for (const s of [httpUp, httpsUp, devUp]) await new Promise((r) => s.close(r));
});

const DNS: Record<string, string[]> = {
  'api.test': ['127.0.0.1'],
  'echo.test': ['127.0.0.1'],
  'other.test': ['127.0.0.1'],
  'evil.test': ['127.0.0.1'],
  'internal.test': ['10.0.0.5'],
  'rebind.test': ['127.0.0.1', '10.1.1.1'],
  'dev.test': ['127.0.0.2'],
};

interface Env {
  proxy: EgressProxyService;
  audit: AuditRecord[];
  lookups: string[];
}

let env: Env;
afterEach(async () => {
  await env.proxy.close();
  seen.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { ca?: boolean; credentials?: EgressCredential[] } = {}): Env {
  dir = mkdtempSync(join(tmpdir(), 'nova-egress-'));
  const audit: AuditRecord[] = [];
  const lookups: string[] = [];
  const proxy = new EgressProxyService({
    socketDir: join(dir, 's'),
    ca: opts.ca === false ? null : new CertificateAuthority(hubCa.certPem, hubCa.keyPem),
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    resolve: (host) => {
      lookups.push(host);
      return Promise.resolve(DNS[host] ?? []);
    },
    // The local upstream stands in for a public server; every other address keeps its class.
    classify: (a) => (a === '127.0.0.1' ? 'public' : classifyAddress(a)),
    upstreamCa: [upstreamCa.certPem],
    credentials: () => Promise.resolve(opts.credentials ?? []),
  });
  env = { proxy, audit, lookups };
  return env;
}

const policy = (p: Partial<ProxyPolicy> = {}): ProxyPolicy => ({
  mode: 'allowlist',
  allow: ['api.test'],
  deny: [],
  credentials: [],
  allowLocalBinding: false,
  ...p,
});

function open(p: Partial<ProxyPolicy> = {}): Promise<LocalEgressSession> {
  return env.proxy.open({
    accountId: ACCOUNT,
    scope: { kind: 'sandbox', id: 'sbx-1' },
    policy: policy(p),
  });
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request through the proxy: absolute-form over the loopback listener, or the Unix socket. */
function viaProxy(
  s: LocalEgressSession,
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    unix?: boolean;
    noAuth?: boolean;
  } = {},
): Promise<Res> {
  const p = new URL(s.proxyUrl);
  const auth = `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(opts.unix
          ? { socketPath: join(s.dir, s.socketName) }
          : { host: p.hostname, port: Number(p.port) }),
        method: opts.method ?? 'GET',
        path: url,
        headers: {
          host: new URL(url).host,
          ...(opts.unix || opts.noAuth ? {} : { 'proxy-authorization': auth }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** CONNECT, then (when the tunnel opens) one HTTPS request over it trusting `ca`. */
function viaConnect(
  s: LocalEgressSession,
  host: string,
  port: number,
  opts: { ca: string; method?: string; path?: string; hostHeader?: string },
): Promise<Res> {
  const p = new URL(s.proxyUrl);
  const auth = `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = request({
      host: p.hostname,
      port: Number(p.port),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { 'proxy-authorization': auth },
    });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [head];
        socket.on('data', (c: Buffer) => chunks.push(c));
        socket.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        return;
      }
      const tls = tlsConnect({ socket, servername: host, ca: opts.ca }, () => {
        tls.write(
          `${opts.method ?? 'GET'} ${opts.path ?? '/'} HTTP/1.1\r\nHost: ${opts.hostHeader ?? host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      const chunks: Buffer[] = [];
      tls.on('data', (c: Buffer) => chunks.push(c));
      tls.on('error', reject);
      tls.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const [head = '', ...rest] = raw.split('\r\n\r\n');
        const [statusLine = '', ...lines] = head.split('\r\n');
        const headers: IncomingHttpHeaders = {};
        for (const l of lines) {
          const i = l.indexOf(':');
          headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
        resolve({ status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy: allowlist, denylist and the bare wildcard', () => {
  it('forwards an allowed request and blocks an unlisted host with a cause header', async () => {
    setup();
    const s = await open();
    const ok = await viaProxy(s, `http://api.test:${httpPort}/data?q=private-query`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).url).toBe('/data?q=private-query');
    const no = await viaProxy(s, `http://elsewhere.test:${httpPort}/`);
    expect(no.status).toBe(403);
    expect(no.headers['x-nova-block-cause']).toBe('allowlist');
    expect(no.body).toContain('elsewhere.test');
    // The unlisted host was never looked up.
    expect(env.lookups).toEqual(['api.test']);
    // Every decision is audited, without the path or query.
    expect(env.audit.map((a) => [a.kind, a.decision, a.result])).toEqual([
      ['network', 'allow', '200'],
      ['network', 'deny', 'allowlist'],
    ]);
    expect(env.audit[0]).toMatchObject({
      action: 'egress.request',
      resource: `api.test:${httpPort}`,
      detail: { method: 'GET', host: 'api.test', mode: 'allowlist', addressClass: 'public' },
    });
    expect(JSON.stringify(env.audit)).not.toContain('private-query');
    expect(JSON.stringify(env.audit)).not.toContain('/data');
  });

  it('lets a deny entry win over a wildcard allow', async () => {
    setup();
    const s = await open({
      allow: ['*.test.example', 'api.test', 'other.test'],
      deny: ['other.test'],
    });
    expect((await viaProxy(s, `http://api.test:${httpPort}/`)).status).toBe(200);
    const no = await viaProxy(s, `http://other.test:${httpPort}/`);
    expect(no.status).toBe(403);
    expect(no.headers['x-nova-block-cause']).toBe('denylist');
    expect(env.audit.at(-1)?.detail).toMatchObject({ rule: 'other.test', cause: 'denylist' });
  });

  it('rejects a bare * and misplaced wildcards when the policy loads', async () => {
    setup();
    await expect(open({ allow: ['*'] })).rejects.toMatchObject({ code: 'validation' });
    await expect(open({ allow: ['api.*.test'] })).rejects.toMatchObject({ code: 'validation' });
    await expect(open({ allow: ['*.com'] })).rejects.toMatchObject({ code: 'validation' });
    await expect(open({ deny: ['*'] })).rejects.toMatchObject({ code: 'validation' });
    expect(env.proxy.sessionCount).toBe(0);
  });

  it('blocks everything in mode off, and needs the session token on the loopback port', async () => {
    setup();
    const off = await open({ mode: 'off' });
    const r = await viaProxy(off, `http://api.test:${httpPort}/`);
    expect(r.status).toBe(403);
    expect(r.headers['x-nova-block-cause']).toBe('policy');
    const s = await open();
    expect((await viaProxy(s, `http://api.test:${httpPort}/`, { noAuth: true })).status).toBe(407);
    // The Unix socket is the sandbox's own route: no token needed there.
    expect((await viaProxy(s, `http://api.test:${httpPort}/`, { unix: true })).status).toBe(200);
  });
});

describe('egress proxy: private addresses and redirects', () => {
  it('blocks names that resolve to private addresses and private literals', async () => {
    setup();
    const s = await open({
      allow: ['internal.test', 'rebind.test', '169.254.169.254', '10.0.0.5'],
    });
    for (const url of [
      'http://internal.test/',
      'http://rebind.test/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
    ]) {
      const r = await viaProxy(s, url);
      expect(r.status, url).toBe(403);
      expect(r.headers['x-nova-block-cause'], url).toBe('private_address');
    }
    expect(env.audit.map((a) => (a.detail as { addressClass: string }).addressClass)).toEqual([
      'private',
      'private',
      'link_local',
      'private',
    ]);
  });

  it('reaches a private dev server only with local binding and a grant for its host and port', async () => {
    setup();
    const s = await open({ allow: ['dev.test'], allowLocalBinding: false });
    expect((await viaProxy(s, `http://dev.test:${devPort}/`)).headers['x-nova-block-cause']).toBe(
      'private_address',
    );
    const local = await open({ allow: [], allowLocalBinding: true });
    expect((await viaProxy(local, `http://dev.test:${devPort}/`)).status).toBe(403);
    const revoke = env.proxy.grantDevServer({
      accountId: ACCOUNT,
      scope: { kind: 'sandbox', id: 'sbx-1' },
      host: 'dev.test',
      port: devPort,
    });
    expect((await viaProxy(local, `http://dev.test:${devPort}/`)).status).toBe(200);
    // Another port of the same host is not covered.
    expect((await viaProxy(local, `http://dev.test:${devPort + 1}/`)).status).toBe(403);
    revoke();
    expect((await viaProxy(local, `http://dev.test:${devPort}/`)).status).toBe(403);
  });

  it('never follows a redirect: the next hop is checked as a new request', async () => {
    setup();
    const s = await open();
    const first = await viaProxy(s, `http://api.test:${httpPort}/redirect`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('http://evil.test/landing');
    const next = await viaProxy(s, first.headers.location!);
    expect(next.status).toBe(403);
    expect(next.headers['x-nova-block-cause']).toBe('allowlist');
  });
});

describe('egress proxy: limited mode and HTTPS inspection', () => {
  it('allows only GET, HEAD and OPTIONS in limited mode', async () => {
    setup();
    const s = await open({ mode: 'limited' });
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect((await viaProxy(s, `http://api.test:${httpPort}/`, { method })).status).toBe(200);
    const post = await viaProxy(s, `http://api.test:${httpPort}/`, { method: 'POST', body: 'x' });
    expect(post.status).toBe(403);
    expect(post.headers['x-nova-block-cause']).toBe('method');
    expect(seen.map((x) => x.method)).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('inspects HTTPS with the per-Hub CA to check methods in limited mode', async () => {
    setup();
    const s = await open({ mode: 'limited' });
    expect(s.caCertPem).toBe(hubCa.certPem);
    const get = await viaConnect(s, 'api.test', httpsPort, { ca: hubCa.certPem, path: '/x' });
    expect(get.status).toBe(200);
    const post = await viaConnect(s, 'api.test', httpsPort, { ca: hubCa.certPem, method: 'POST' });
    expect(post.status).toBe(403);
    expect(post.headers['x-nova-block-cause']).toBe('method');
    // A Host header naming another host than the tunnel is refused (no fronting).
    const fronted = await viaConnect(s, 'api.test', httpsPort, {
      ca: hubCa.certPem,
      hostHeader: 'evil.test',
    });
    expect(fronted.status).toBe(403);
    expect(env.audit.filter((a) => a.detail?.inspected === true)).toHaveLength(3);
  });

  it('blocks HTTPS it cannot inspect in limited mode, and tunnels it in allowlist mode', async () => {
    setup({ ca: false });
    const limited = await open({ mode: 'limited' });
    const r = await viaConnect(limited, 'api.test', httpsPort, { ca: upstreamCa.certPem });
    expect(r.status).toBe(403);
    expect(r.headers['x-nova-block-cause']).toBe('inspection');
    expect(limited.caCertPem).toBeNull();
    const open2 = await open();
    // Not inspected: the client sees the upstream's own certificate.
    const t = await viaConnect(open2, 'api.test', httpsPort, { ca: upstreamCa.certPem });
    expect(t.status).toBe(200);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(env.audit.at(-1)).toMatchObject({
      action: 'egress.connect',
      decision: 'allow',
      detail: { inspected: false },
    });
    expect((env.audit.at(-1)?.detail as { bytesIn: number }).bytesIn).toBeGreaterThan(0);
  });

  it('answers a blocked CONNECT with 403 and the cause', async () => {
    setup();
    const s = await open();
    const r = await viaConnect(s, 'evil.test', 443, { ca: hubCa.certPem });
    expect(r.status).toBe(403);
    expect(r.headers['x-nova-block-cause']).toBe('allowlist');
    expect(r.body).toContain('evil.test');
  });
});

describe('egress proxy: credential injection (ADR-063) and header hygiene', () => {
  const credential = (over: Partial<EgressCredential> = {}): EgressCredential => ({
    id: 'cred-1',
    hosts: ['api.test'],
    scheme: 'bearer',
    header: null,
    username: null,
    value: () => Promise.resolve(SECRET),
    ...over,
  });

  it('adds the credential to requests to its host only, and masks it in responses', async () => {
    setup({ credentials: [credential()] });
    const s = await open({ allow: ['api.test', 'echo.test'], credentials: ['cred-1'] });
    const api = await viaProxy(s, `http://api.test:${httpPort}/`);
    expect(api.status).toBe(200);
    // The upstream received it ...
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    // ... but the sandbox never sees it, in the body or in headers.
    expect(api.body).not.toContain(SECRET);
    expect(String(api.headers['x-echo-auth'])).not.toContain(SECRET);
    const other = await viaProxy(s, `http://echo.test:${httpPort}/`);
    expect(seen[1]?.headers.authorization).toBeUndefined();
    expect(other.body).not.toContain(SECRET);
    expect(env.audit[0]?.detail).toMatchObject({ credentials: ['cred-1'] });
    expect(JSON.stringify(env.audit)).not.toContain(SECRET);
  });

  it('injects over inspected HTTPS, as basic auth or a named header', async () => {
    setup({
      credentials: [
        credential({ scheme: 'basic', username: 'bot' }),
        credential({ id: 'cred-2', hosts: ['echo.test'], scheme: 'header', header: 'X-Api-Key' }),
      ],
    });
    const s = await open({ allow: ['api.test', 'echo.test'], credentials: ['cred-1', 'cred-2'] });
    const r = await viaConnect(s, 'api.test', httpsPort, { ca: hubCa.certPem });
    expect(r.status).toBe(200);
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`bot:${SECRET}`).toString('base64')}`,
    );
    expect(r.body).not.toContain(Buffer.from(`bot:${SECRET}`).toString('base64'));
    await viaConnect(s, 'echo.test', httpsPort, { ca: hubCa.certPem });
    expect(seen[1]?.headers['x-api-key']).toBe(SECRET);
  });

  it('adds no credential to a tunnel it cannot inspect', async () => {
    setup({ ca: false, credentials: [credential()] });
    const s = await open({ credentials: ['cred-1'] });
    const r = await viaConnect(s, 'api.test', httpsPort, { ca: upstreamCa.certPem });
    expect(r.status).toBe(200);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    // Over plain HTTP it can still be added.
    await viaProxy(s, `http://api.test:${httpPort}/`);
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('strips tracking headers and applies stripping hooks', async () => {
    setup();
    const s = await open({
      allow: ['api.test'],
      hooks: [
        {
          id: 'h1',
          host: 'api.test',
          methods: ['POST'],
          action: 'strip_header',
          header: 'Authorization',
        },
        { id: 'h2', host: 'api.test', action: 'strip_cookies' },
        { id: 'h3', host: 'api.test', pathPrefix: '/admin', action: 'block' },
      ],
    });
    await viaProxy(s, `http://api.test:${httpPort}/`, {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer user-typed',
        cookie: 'a=b',
        'x-forwarded-for': '10.9.9.9',
        traceparent: '00-abc-def-01',
        'x-kept': 'yes',
      },
    });
    const h = seen[0]!.headers;
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(h.traceparent).toBeUndefined();
    expect(h['x-kept']).toBe('yes');
    const blocked = await viaProxy(s, `http://api.test:${httpPort}/admin/users`);
    expect(blocked.status).toBe(403);
    expect(blocked.headers['x-nova-block-cause']).toBe('policy');
    expect(env.audit.at(-1)?.detail).toMatchObject({ rule: 'hook:h3' });
    // A hook blocking a whole host also stops a tunnel that is not inspected.
    const whole = await open({
      allow: ['api.test'],
      hooks: [{ id: 'h4', host: 'api.test', action: 'block' }],
    });
    const tunnel = await viaConnect(whole, 'api.test', httpsPort, { ca: hubCa.certPem });
    expect(tunnel.status).toBe(403);
    expect(tunnel.headers['x-nova-block-cause']).toBe('policy');
  });
});

describe('egress proxy: sessions', () => {
  it('gives each session its own listeners and removes them on close', async () => {
    setup();
    const a = await open();
    const b = await open({ allow: ['echo.test'] });
    expect(a.proxyUrl).not.toBe(b.proxyUrl);
    expect(a.dir).not.toBe(b.dir);
    // Only the Hub's user can reach a session's socket.
    expect(statSync(join(a.dir, a.socketName)).mode & 0o777).toBe(0o600);
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
    expect((await viaProxy(b, `http://api.test:${httpPort}/`)).status).toBe(403);
    await a.close();
    await expect(viaProxy(a, `http://api.test:${httpPort}/`)).rejects.toThrow();
    expect(env.proxy.sessionCount).toBe(1);
    // A socket folder whose paths are too long fails cleanly, leaving nothing behind.
    const long = new EgressProxyService({ socketDir: join(dir, 'x'.repeat(120)) });
    await expect(
      long.open({ accountId: ACCOUNT, scope: { kind: 'sandbox', id: 'x' }, policy: policy() }),
    ).rejects.toThrow('too long');
    expect(long.sessionCount).toBe(0);
    await long.close();
    const p: EgressPolicy = policy();
    expect(p.allow).toEqual(['api.test']);
  });
});
