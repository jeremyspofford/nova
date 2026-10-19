// Listener hygiene (FR-192, docs/12 §15): every Hub route refuses unauthenticated use, tokens are
// accepted only as documented (session cookie or `Authorization: Bearer`), loopback is never an
// authorization, and requests or WebSocket upgrades with a foreign Origin or Host are refused.
// The route sweep reads the live route table, so routes added later are covered too.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { uuidv7 } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const HOST = '127.0.0.1:7419';

/** Routes that authenticate another way, or not at all by design (contracts/hub-api.md §1). */
const PUBLIC: Record<string, string> = {
  'GET /api/v1/hello': 'capability handshake',
  'GET /api/v1/health': 'liveness',
  'GET /api/v1/channels/oauth/callback': 'single-use OAuth state in the query (M8 email OAuth)',
  'POST /api/v1/auth/setup': 'one-use setup code in the body',
  'POST /node/v1/register': 'one-use enrollment token in the body',
  'POST /node/v1/heartbeat': 'node credential',
  'POST /node/v1/models/sync': 'node credential',
  // novad devices (docs/23): enrollment token, then the device credential.
  'POST /agent/v1/register': 'one-use enrollment token in the body',
  'POST /agent/v1/heartbeat': 'device credential',
  'POST /agent/v1/capabilities': 'device credential',
  // M7.5 extension bridge (D8): novad relays the extension's events with its device credential.
  'POST /agent/v1/bridge/events': 'device credential',
  // Inbound deliveries from outside (docs/13 §4, docs/09 §7): each is verified by its sender's
  // signature or token before anything is read, and answers 401 otherwise.
  'POST /api/v1/channels/:id/inbound': "the channel's signature or token",
  'POST /api/v1/triggers/:id/webhook': 'HMAC signature with the trigger secret',
  'POST /api/v1/mcp/events/:subscriptionId': 'HMAC signature with the subscription secret',
  // A cross-site redirect carries no session; the single-use state from the start call is the
  // credential, and the route only ever redirects back to settings (FR-047).
  'GET /api/v1/mcp/oauth/callback': 'single-use OAuth state in the query',
  // Add Device (FR-132, docs/22 §4, §9): a new device has no session yet. All three are rate-limited
  // per client address.
  'POST /api/v1/devices/add/complete':
    'the single-use pairing code in the body (5 minutes; five wrong codes burn it)',
  'POST /api/v1/devices/add/reveal':
    "the commitment from complete and the device key's Ed25519 signature over the request id and a fresh time (a bad one burns the request)",
  'GET /api/v1/devices/add/status/:requestId':
    "the device key's Ed25519 signature over the request id and a time newer than the last poll",
  // Public information a device needs before it can trust the Hub (FR-134, docs/22 §5): the
  // local CA's root certificate (PEM and DER) and the Hub's identity statement, which carries its
  // own Ed25519 signature for native shells to check against their pin. Nothing secret.
  'GET /api/v1/trust/ca.pem': 'none: the root certificate is public',
  'GET /api/v1/trust/ca.crt': 'none: the root certificate is public',
  'GET /api/v1/trust/identity': 'none: public, signed by the Hub identity key',
  // Signed novad builds for the one-line install (FR-133, docs/22 §4.3): not secret; integrity
  // comes from the manifest's Ed25519 signature and each build's SHA-256.
  'GET /api/v1/agent/dist/:file': 'none: public builds, verified by the signed manifest',
  // M7 channels (FR-110): an email approval is answered only through a signed one-use link (HMAC
  // with the Hub's link key, short-lived); GET shows the choices, POST answers once.
  'GET /api/v1/channels/approval-links/:token':
    'a signed one-use approval link; shows the choices, changes nothing',
  'POST /api/v1/channels/approval-links/:token': 'the same signed one-use link; answers once',
  // M7 members (decision 5) and OIDC sign-in (FR-113): a new member has no session yet.
  'POST /api/v1/team/join/preview': 'a one-use invitation token in the body; rate-limited',
  'POST /api/v1/team/join': 'a one-use invitation token in the body; rate-limited',
  'GET /api/v1/auth/oidc/providers': "none: the enabled providers' labels only",
  'POST /api/v1/auth/oidc/start':
    'none to sign in (only the provider URL is returned); join needs an invitation, link a session',
  'GET /api/v1/auth/oidc/callback':
    'single-use 10-minute state, then the ID token checks; redirects to fixed paths only',
  // A public profile card exists only when the owner allows cards and the person opted in.
  'GET /api/v1/profiles/:handle': 'none: opted-in public cards only; rate-limited',
  'GET /api/v1/profiles/:handle/avatar': 'none: opted-in public cards only; rate-limited',
  // M7.5 network boot (FR-143, ADR-096 D5): iPXE has no session. Both are 404 while
  // devices.pxe.enabled is off, and for any token that is not a live boot token.
  'GET /boot/ipxe/:token':
    "the device's PXE boot token in the path (256 random bits, only its hash stored, rotatable); rate-limited, audited",
  'GET /boot/images/:token/:name':
    'the same boot token; a plain file name inside the boot-images folder; rate-limited, audited',
  // M8 third-party apps (FR-222, ADR-097 D6): OAuth 2.0 with PKCE for native public clients. A
  // registered app can do nothing until the owner approves it on the consent API (owner session).
  'POST /api/v1/apps/register':
    'none: an app registers itself (RFC 7591); rate-limited per address, apps awaiting approval capped',
  'POST /api/v1/oauth/token':
    'a one-use authorization code with its PKCE verifier and redirect URI, or a refresh token, bound to the client_id; rate-limited',
  'POST /api/v1/oauth/revoke': 'the token being revoked, bound to its client_id; rate-limited',
  'GET /.well-known/oauth-authorization-server': 'none: public OAuth metadata (RFC 8414)',
};

/** Browser flows that refuse by redirecting to the sign-in page (no session, a fixed path). */
const REFUSES_BY_REDIRECT = new Set(['GET /api/v1/auth/oidc/callback']);

/** Public routes that take no credential at all: they may answer anyone. */
const OPEN = new Set([
  'GET /api/v1/hello',
  'GET /api/v1/health',
  'GET /api/v1/trust/ca.pem',
  'GET /api/v1/trust/ca.crt',
  'GET /api/v1/trust/identity',
  'GET /api/v1/agent/dist/:file',
  'GET /api/v1/auth/oidc/providers',
  'GET /api/v1/profiles/:handle',
  'GET /api/v1/profiles/:handle/avatar',
  'POST /api/v1/apps/register',
  'GET /.well-known/oauth-authorization-server',
]);

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let session: string;
let url: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-listeners-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
  });
  url = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { host: HOST },
    payload: { code },
  });
  session = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
});

afterAll(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every method and path the Hub registered (HEAD mirrors GET), exactly as registered. */
function routes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  return hub.routes().filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, () => uuidv7()).replace(/\*$/, 'x/y.png');

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string | undefined }> {
  const res = await hub.app.inject({
    method: method as 'GET',
    url: path,
    headers: { host: HOST, ...headers },
    ...(['POST', 'PUT', 'PATCH'].includes(method) ? { payload: {} } : {}),
  });
  let code: string | undefined;
  try {
    code = res.json<{ error?: { code?: string } }>().error?.code;
  } catch {
    code = undefined;
  }
  return { status: res.statusCode, code };
}

describe('HTTP routes', () => {
  it('finds the route table', () => {
    const all = routes().map((r) => `${r.method} ${r.path}`);
    expect(all).toContain('GET /api/v1/events/stream');
    expect(all).toContain('GET /api/v1/threads/:id/stream');
    expect(all).toContain('GET /api/v1/mcp/servers/:id/logs');
    expect(all.length).toBeGreaterThan(40);
  });

  it('refuses every non-public API route without a session', async () => {
    const offenders: string[] = [];
    for (const r of routes()) {
      const key = `${r.method} ${r.path}`;
      const api = /^\/(api|node|agent)\//.test(r.path);
      if (PUBLIC[key] || r.path === '/api/v1/ws' || !api) continue;
      const res = await call(r.method, concrete(r.path));
      if (res.status !== 401 || res.code !== 'token_required')
        offenders.push(`${key} -> ${res.status} ${res.code ?? ''}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never lets an unauthenticated call succeed on the public routes that take credentials', async () => {
    for (const key of Object.keys(PUBLIC).filter((k) => !OPEN.has(k))) {
      const [method, path] = key.split(' ') as [string, string];
      if (REFUSES_BY_REDIRECT.has(key)) {
        // A browser flow refuses by sending the browser back to sign-in: never a session.
        const res = await hub.app.inject({ method: 'GET', url: path, headers: { host: HOST } });
        expect(res.statusCode, key).toBe(302);
        expect(res.headers.location, key).toMatch(/^\/sign-in\?/);
        expect(res.headers['set-cookie'], key).toBeUndefined();
        continue;
      }
      const res = await call(method, path);
      expect(res.status, key).toBeGreaterThanOrEqual(400);
      expect(res.status, key).toBeLessThan(500);
    }
  });

  it('serves only the web shell as static content', async () => {
    // `/mcp` is Nova's MCP server (FR-044): it needs a client token of its own, and is off until
    // a client exists (mcp-server.test.ts covers it).
    const statics = routes().filter(
      (r) => !/^\/(api|node|agent)\//.test(r.path) && r.path !== '/mcp',
    );
    for (const r of statics) expect(r.method, r.path).toBe('GET');
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await call(method, '/mcp');
      expect(res.status, `${method} /mcp`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${method} /mcp`).toBeLessThan(500);
    }
  });
});

describe('tokens', () => {
  it('accepts the session as a cookie or a bearer token', async () => {
    expect(
      (await call('GET', '/api/v1/session', { cookie: `${SESSION_COOKIE}=${session}` })).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/v1/session', { authorization: `Bearer ${session}` })).status,
    ).toBe(200);
  });

  it('accepts no other carrier for the same token', async () => {
    const attempts: [string, Record<string, string>][] = [
      [`/api/v1/session?token=${session}`, {}],
      [`/api/v1/session?access_token=${session}`, {}],
      ['/api/v1/session', { 'x-api-key': session }],
      ['/api/v1/session', { 'x-nova-token': session }],
      ['/api/v1/session', { authorization: session }],
      [
        '/api/v1/session',
        { authorization: `Basic ${Buffer.from(`owner:${session}`).toString('base64')}` },
      ],
      ['/api/v1/session', { authorization: `Token ${session}` }],
      ['/api/v1/session', { cookie: `session=${session}` }],
      ['/api/v1/session', { cookie: `${SESSION_COOKIE}x=${session}` }],
    ];
    for (const [path, headers] of attempts) {
      const res = await call('GET', path, headers);
      expect(res.status, `${path} ${JSON.stringify(Object.keys(headers))}`).toBe(401);
    }
  });

  it('refuses setup codes and unknown or malformed tokens', async () => {
    const code = await hub.auth.issueSetupCode();
    for (const token of [code, 'nvs_' + 'a'.repeat(43), '', 'x'.repeat(5000)]) {
      const res = await call('GET', '/api/v1/session', { authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
    }
  });
});

describe('loopback is not an authorization', () => {
  it('refuses unauthenticated requests from 127.0.0.1 over the network', async () => {
    for (const path of [
      '/api/v1/session',
      '/api/v1/threads',
      '/api/v1/mcp/servers',
      '/api/v1/settings',
    ]) {
      const res = await fetch(`${url}${path}`, {
        headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
      });
      expect(res.status, path).toBe(401);
    }
  });

  it('refuses an unauthenticated event stream', async () => {
    for (const path of ['/api/v1/events/stream', `/api/v1/threads/${uuidv7()}/stream`]) {
      const res = await fetch(`${url}${path}`, { headers: { accept: 'text/event-stream' } });
      expect(res.status, path).toBe(401);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
      await res.body?.cancel();
    }
  });
});

describe('Origin and Host', () => {
  it('refuses a foreign Host even with a session (DNS rebinding)', async () => {
    const res = await hub.app.inject({
      url: '/api/v1/session',
      headers: { host: 'evil.example', cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_rejected');
    const pub = await hub.app.inject({
      url: '/api/v1/health',
      headers: { host: 'evil.example:7419' },
    });
    expect(pub.statusCode).toBe(403);
  });

  it('refuses a foreign Origin even with a session, and allows the Hub’s own', async () => {
    const foreign = await call('GET', '/api/v1/session', {
      origin: 'http://evil.example',
      cookie: `${SESSION_COOKIE}=${session}`,
    });
    expect(foreign).toEqual({ status: 403, code: 'origin_rejected' });
    const stream = await call('GET', `/api/v1/threads/${uuidv7()}/stream`, {
      origin: 'http://evil.example',
      cookie: `${SESSION_COOKIE}=${session}`,
    });
    expect(stream.status).toBe(403);
    const own = await call('GET', '/api/v1/session', {
      origin: `http://${HOST}`,
      cookie: `${SESSION_COOKIE}=${session}`,
    });
    expect(own.status).toBe(200);
  });
});

describe('WebSocket upgrades', () => {
  const wsUrl = () => `${url.replace('http', 'ws')}/api/v1/ws`;

  /** Open a socket and report how it ends: a refused handshake, a close code, or a first message. */
  function open(
    opts: WebSocket.ClientOptions,
  ): Promise<{ refused?: number; close?: number; message?: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl(), opts);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ refused: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.on('message', (data: Buffer) => {
        resolve({ message: data.toString('utf8') });
        ws.close();
      });
      ws.on('close', (code) => resolve({ close: code }));
      ws.on('error', () => undefined);
    });
  }

  it('refuses an upgrade from a foreign Origin, even with a session', async () => {
    const r = await open({
      origin: 'http://evil.example',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(r.refused).toBe(403);
  });

  it('refuses an upgrade with a foreign Host', async () => {
    const r = await open({
      headers: { host: 'evil.example', cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(r.refused).toBe(403);
  });

  it('refuses an upgrade without a session in the handshake', async () => {
    const r = await open({});
    expect(r).toEqual({ refused: 401 });
    const q = await open({ headers: { cookie: `session=${session}` } });
    expect(q).toEqual({ refused: 401 });
  });

  it('accepts a session with the Hub’s own Origin', async () => {
    const r = await open({
      origin: url,
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(JSON.parse(r.message ?? '{}')).toMatchObject({ type: 'hello' });
  });
});
