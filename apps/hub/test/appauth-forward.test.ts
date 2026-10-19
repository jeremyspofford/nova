// A Nova app code must never reach the Hub's own callbacks (M8 access review, finding 1): the
// email and MCP OAuth callbacks post the code they receive to a token endpoint the binding's or
// server's author chose, so a code delivered there could be redeemed by someone else. The review's
// probe, ported: a redirect URI on the Hub's own routes or ports is refused at registration and at
// consent; the email callback refuses a code whose `iss` is not its provider (or is this Hub); the
// MCP callback refuses a code this Hub issued even when the server's metadata claims the Hub's
// issuer. Legitimate loopback redirects and provider codes still work.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { HOST, cookieOf, type WireJson } from './team-env.ts';

const HUB = `http://${HOST.host}`;

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let owner: Record<string, string>;
/** An OAuth provider and MCP server someone else controls: it records every token request. */
let evil: Server;
let evilBase: string;
let tokenPosts: string[];

beforeEach(async () => {
  tokenPosts = [];
  evil = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', evilBase).pathname;
      const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(v));
      };
      if (path.startsWith('/.well-known/oauth-protected-resource'))
        return json(200, { resource: `${evilBase}/mcp`, authorization_servers: [evilBase] });
      if (
        path.startsWith('/.well-known/oauth-authorization-server') ||
        path.startsWith('/.well-known/openid-configuration')
      )
        return json(200, {
          issuer: evilBase,
          authorization_endpoint: `${evilBase}/authorize`,
          token_endpoint: `${evilBase}/token`,
          registration_endpoint: `${evilBase}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (path === '/register') {
        const reg = JSON.parse(body || '{}') as { redirect_uris?: string[] };
        return json(201, {
          client_id: 'evil-client',
          redirect_uris: reg.redirect_uris ?? [],
          token_endpoint_auth_method: 'none',
        });
      }
      if (path === '/token') {
        tokenPosts.push(body);
        return json(400, { error: 'invalid_grant' });
      }
      if (path === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${evilBase}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  evilBase = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), 'nova-hub-appauth-fwd-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
  });
  const code = await hub.auth.issueSetupCode();
  const setup = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code },
  });
  owner = { ...HOST, authorization: `Bearer ${cookieOf(setup)!}` };
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  await new Promise<void>((r) => evil.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) {
  const res = await hub.app.inject({
    method,
    url,
    headers: { ...HOST, ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  let body: WireJson;
  try {
    body = res.json<WireJson>();
  } catch {
    body = {};
  }
  return { status: res.statusCode, location: res.headers.location, body };
}

const register = (redirectUris: string[], headers: Record<string, string> = {}) =>
  call('POST', '/api/v1/apps/register', headers, {
    name: 'Nova Mobile',
    redirectUris,
    scopes: ['threads:read'],
  });

function consentQuery(clientId: string, redirectUri: string, state = 's1'): string {
  const challenge = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('base64url');
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'threads:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
}

/** An email binding whose OAuth provider is the evil server; returns its id and a fresh state. */
async function emailBinding(): Promise<{ id: string; start: () => Promise<string> }> {
  const created = await call('POST', '/api/v1/channels', owner, {
    kind: 'email',
    externalRef: 'x@example.com',
    audience: 'private',
    config: {
      address: 'x@example.com',
      imapHost: '127.0.0.1',
      imapPort: 1,
      imapSecurity: 'none',
      smtpHost: '127.0.0.1',
      smtpPort: 1,
      smtpSecurity: 'none',
      mode: 'polling',
      auth: 'oauth',
      oauthAuthUrl: `${evilBase}/authorize`,
      oauthTokenUrl: `${evilBase}/token`,
      oauthClientId: 'evil-client',
      oauthScopes: 'mail',
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  return {
    id,
    start: async () => {
      const s = await call('POST', `/api/v1/channels/${id}/oauth/start`, owner, {});
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      return new URL(s.body.authorizeUrl as string).searchParams.get('state')!;
    },
  };
}

describe('redirect URIs on the Hub itself', () => {
  it("refuses the review's probe: an app registered on the Hub's own email callback", async () => {
    const binding = await emailBinding();
    await binding.start();
    const reg = await register(['http://127.0.0.1/api/v1/channels/oauth/callback']);
    expect(reg.status).toBe(400);
    expect(reg.body.error.details).toEqual({ field: 'redirectUris', reason: 'hub_path' });
    for (const uri of [
      'http://127.0.0.1/API/v1/x',
      'http://[::1]/mcp',
      'http://127.0.0.1//api/v1/x',
      'http://127.0.0.1/%61pi/v1/x',
      'http://127.0.0.1/boot/ipxe/x',
      'http://127.0.0.1/.well-known/x',
    ]) {
      const r = await register([uri]);
      expect(r.body.error?.details, uri).toEqual({ field: 'redirectUris', reason: 'hub_path' });
    }
    // A port of the Hub is refused at registration too.
    const port = await register([`${HUB}/callback`]);
    expect(port.body.error.details).toEqual({ field: 'redirectUris', reason: 'hub_address' });
    expect(tokenPosts).toEqual([]);
  });

  it("refuses at consent a loopback redirect on the Hub's port, and never redirects there", async () => {
    const reg = await register(['http://127.0.0.1/callback']);
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    for (const uri of [
      `${HUB}/callback`,
      'http://[::1]:7419/callback',
      'http://127.0.0.1:7420/callback',
    ]) {
      const q = consentQuery(clientId, uri);
      const consent = await call('GET', `/api/v1/apps/authorize?${q}`, owner);
      expect(consent.status, uri).toBe(400);
      expect(consent.body.error.details, uri).toEqual({ reason: 'redirect_uri_reserved' });
      const decided = await call('POST', '/api/v1/apps/authorize', owner, {
        query: q,
        decision: 'approve',
      });
      expect(decided.status, uri).toBe(400);
      expect(decided.body.redirectTo).toBeUndefined();
    }
    // An ordinary loopback port is fine.
    const ok = await call(
      'GET',
      `/api/v1/apps/authorize?${consentQuery(clientId, 'http://127.0.0.1:53999/callback')}`,
      owner,
    );
    expect(ok.status).toBe(200);
  });
});

describe('the email OAuth callback', () => {
  const back = (state: string, extra: Record<string, string>) =>
    `/api/v1/channels/oauth/callback?${new URLSearchParams({ state, code: 'stolen', ...extra }).toString()}`;

  it("never posts a code this Hub issued, or one another issuer sent, to the binding's token URL", async () => {
    const binding = await emailBinding();
    for (const iss of [HUB, 'http://localhost:7419', 'https://other-provider.example']) {
      const cb = await call('GET', back(await binding.start(), { iss }), {});
      expect(cb.status, iss).toBe(302);
      expect(cb.location, iss).toBe('/settings/channels?oauth=error');
    }
    expect(tokenPosts).toEqual([]);
    const view = await call('GET', `/api/v1/channels/${binding.id}`, owner);
    expect(JSON.stringify(view.body)).toContain('not issued by this mailbox');
  });

  it("still exchanges a code from the mailbox's own provider, with or without iss", async () => {
    const binding = await emailBinding();
    await call('GET', back(await binding.start(), { iss: evilBase }), {});
    await call('GET', back(await binding.start(), {}), {});
    expect(tokenPosts).toHaveLength(2);
    expect(tokenPosts[0]).toContain('code=stolen');
  });
});

describe('the MCP OAuth callback', () => {
  async function mcpState(): Promise<string> {
    const added = await call('POST', '/api/v1/mcp/servers', owner, {
      name: 'evil',
      transport: 'http',
      url: `${evilBase}/mcp`,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const start = await call(
      'POST',
      `/api/v1/mcp/servers/${added.body.id as string}/oauth/start`,
      owner,
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    return new URL(start.body.authorizeUrl as string).searchParams.get('state')!;
  }

  it('refuses a code this Hub issued and spends the state', async () => {
    // The exchange checks `iss` against the server's metadata (which must name the server's own
    // URL); the Hub refuses its own issuer before that, whatever the metadata says.
    const state = await mcpState();
    const cb = await call(
      'GET',
      `/api/v1/mcp/oauth/callback?${new URLSearchParams({ state, code: 'stolen', iss: HUB }).toString()}`,
      {},
    );
    expect(cb.location).toBe('/settings/tools?oauth=error');
    expect(tokenPosts).toEqual([]);
    // The state was spent: it cannot be replayed.
    const again = await call(
      'GET',
      `/api/v1/mcp/oauth/callback?${new URLSearchParams({ state, code: 'stolen' }).toString()}`,
      {},
    );
    expect(again.location).toBe('/settings/tools?oauth=error');
    expect(tokenPosts).toEqual([]);
  });

  it('still exchanges a code that names the server as its issuer', async () => {
    const state = await mcpState();
    await call(
      'GET',
      `/api/v1/mcp/oauth/callback?${new URLSearchParams({ state, code: 'fine', iss: evilBase }).toString()}`,
      {},
    );
    expect(tokenPosts).toHaveLength(1);
    expect(tokenPosts[0]).toContain('code=fine');
  });
});

describe('closed registration', () => {
  it('lets only the owner register while apps.openRegistration is off, past the limits', async () => {
    const off = await call('PATCH', '/api/v1/settings', owner, {
      key: 'apps.openRegistration',
      value: false,
      scope: 'global',
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const anon = await register(['http://127.0.0.1/cb']);
    expect(anon.status).toBe(403);
    expect(anon.body.error.details).toEqual({ reason: 'registration_closed' });
    for (let i = 0; i < 12; i++)
      expect((await register(['http://127.0.0.1/cb'], owner)).status).toBe(201);
  });
});
