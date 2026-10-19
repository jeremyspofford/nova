// Third-party app authorization against the wired Hub (FR-222, ADR-097 D6): an app registers,
// the owner approves on the consent API, the app trades its code and PKCE verifier for tokens,
// calls a route its scope opens and is refused everywhere else (other scopes, owner
// administration, writes, the consent API itself, a cookie carrier), refreshes with rotation, a
// reused refresh token ends the chain, and the app or the owner revokes. Wrong verifiers, redirect
// mismatches, non-loopback http redirects, members, managed policy and `apps.enabled` are refused.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { buildHub, type Hub } from '../src/app.ts';
import type { AppAuthArea } from '../src/appauth.ts';
import { loadConfig } from '../src/config.ts';
import { HOST, cookieOf, type WireJson } from './team-env.ts';

const REDIRECT = 'http://127.0.0.1:53999/callback';

interface Env {
  dir: string;
  db: NovaDatabase;
  hub: Hub;
  owner: { accountId: string; headers: Record<string, string> };
  join(name: string): Promise<{ accountId: string; headers: Record<string, string> }>;
}

let t: Env;
let area: AppAuthArea;
/** The managed settings layer (what the managed area would put there). */
let managed: Record<string, unknown> = {};

/** The fully wired Hub (its apps area is `Hub.appAuth`), with an owner and a way to add members. */
async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-hub-appauth-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  managed = {};
  const secrets = new MemorySecretStore();
  const log = new Logger({ module: 'hub', sinks: [new MemorySink()] });
  const hub = await buildHub({
    config,
    db,
    log,
    secrets,
    managedSettings: () => managed,
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  area = hub.appAuth;

  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  const owner = {
    accountId: res.json<{ accountId: string }>().accountId,
    headers: { ...HOST, authorization: `Bearer ${cookieOf(res)!}` },
  };
  const joinMember = async (name: string) => {
    const inv = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/invitations',
      headers: owner.headers,
      payload: {},
    });
    const joined = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/join',
      headers: HOST,
      payload: { token: inv.json<{ token: string }>().token, displayName: name },
    });
    if (joined.statusCode !== 201) throw new Error(`join failed: ${joined.body}`);
    return {
      accountId: joined.json<{ accountId: string }>().accountId,
      headers: { ...HOST, authorization: `Bearer ${cookieOf(joined)!}` },
    };
  };
  return { dir, db, hub, owner, join: joinMember };
}

beforeEach(async () => {
  t = await makeEnv();
});

afterEach(async () => {
  await t.hub.app.close();
  t.db.close();
  rmSync(t.dir, { recursive: true, force: true });
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) {
  const res = await t.hub.app.inject({
    method,
    url,
    headers: { ...HOST, ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body ? res.json<WireJson>() : {},
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A form-encoded body, as OAuth clients send it. */
async function form(url: string, fields: Record<string, string>) {
  const res = await t.hub.app.inject({
    method: 'POST',
    url,
    headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
  return { status: res.statusCode, headers: res.headers, body: res.json<WireJson>() };
}

async function registerApp(scopes = ['threads:read', 'projects:read']): Promise<string> {
  const res = await call(
    'POST',
    '/api/v1/apps/register',
    {},
    {
      name: 'Notes',
      redirectUris: ['http://127.0.0.1/callback', 'com.example.notes:/oauth'],
      scopes,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.client_id as string;
}

function authorizeQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'threads:read projects:read',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...over,
  }).toString();
}

/** Register, approve as the owner, exchange: the app's first tokens. */
async function signIn(scopes?: string[]) {
  const clientId = await registerApp(scopes);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge);
  const decided = await call('POST', '/api/v1/apps/authorize', t.owner.headers, {
    query: `?${query}`,
    decision: 'approve',
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const back = new URL(decided.body.redirectTo as string);
  const tokens = await form('/api/v1/oauth/token', {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
  return { clientId, tokens: tokens.body, back };
}

function auditActions(): {
  action: string;
  decision: string | null;
  result: string | null;
  detail: WireJson;
}[] {
  return (
    t.db.raw
      .prepare('SELECT action, decision, result, detail_json FROM audit_event ORDER BY seq')
      .all() as {
      action: string;
      decision: string | null;
      result: string | null;
      detail_json: string | null;
    }[]
  ).map((r) => ({
    action: r.action,
    decision: r.decision,
    result: r.result,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as WireJson) : {},
  }));
}

describe('the full PKCE flow', () => {
  it('registers, shows the consent, approves, exchanges, calls a scoped route and refuses the rest', async () => {
    const clientId = await registerApp();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge);

    // The consent page needs the owner's session.
    expect((await call('GET', `/api/v1/apps/authorize?${query}`, {})).status).toBe(401);
    const consent = await call('GET', `/api/v1/apps/authorize?${query}`, t.owner.headers);
    expect(consent.status).toBe(200);
    expect(consent.body).toMatchObject({
      client: { id: clientId, name: 'Notes', redirectUri: REDIRECT, redirectKind: 'loopback' },
      authorized: false,
    });
    expect(consent.body.scopes.map((s: WireJson) => s.label)).toEqual([
      'See your projects',
      'Read your chats',
    ]);

    const decided = await call('POST', '/api/v1/apps/authorize', t.owner.headers, {
      query: `?${query}`,
      decision: 'approve',
    });
    expect(decided.headers['cache-control']).toBe('no-store');
    const back = new URL(decided.body.redirectTo as string);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(`http://${HOST.host}`);

    const tokens = await form('/api/v1/oauth/token', {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.headers['cache-control']).toBe('no-store');
    expect(tokens.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'projects:read threads:read',
    });
    const access = tokens.body.access_token as string;
    expect(access).toMatch(/^nva_/);

    // A thread the owner made, read by the app.
    const thread = await call('POST', '/api/v1/threads', t.owner.headers, { title: 'Hello' });
    expect(thread.status).toBe(201);
    const list = await call('GET', '/api/v1/threads', bearer(access));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: WireJson) => i.id)).toContain(thread.body.id);
    expect(
      (await call('GET', `/api/v1/threads/${thread.body.id as string}`, bearer(access))).status,
    ).toBe(200);
    expect((await call('GET', '/api/v1/projects', bearer(access))).status).toBe(200);

    // Another scope's route: 403 insufficient_scope with the RFC 6750 header.
    const usage = await call('GET', '/api/v1/usage', bearer(access));
    expect(usage.status).toBe(403);
    expect(usage.body.error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'insufficient_scope', scope: 'usage:read' },
    });
    expect(usage.headers['www-authenticate']).toContain('error="insufficient_scope"');

    // Owner administration, writes, the consent API and the app list: never for an app token.
    for (const [method, url, payload] of [
      ['PATCH', '/api/v1/settings', { key: 'apps.enabled', value: false }],
      ['GET', '/api/v1/settings', undefined],
      ['GET', '/api/v1/apps', undefined],
      ['GET', '/api/v1/app-authorizations', undefined],
      ['POST', '/api/v1/apps/authorize', { query: `?${query}`, decision: 'approve' }],
      ['POST', '/api/v1/threads', { title: 'x' }],
      ['GET', '/api/v1/session', undefined],
      ['GET', '/api/v1/diagnostics', undefined],
    ] as const) {
      const res = await call(method, url, bearer(access), payload);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.error.details, `${method} ${url}`).toEqual({ reason: 'not_app_scoped' });
    }
    expect(
      await t.hub.app
        .inject({
          method: 'GET',
          url: '/api/v1/settings',
          headers: { ...HOST, ...t.owner.headers },
        })
        .then((r) => r.statusCode),
    ).toBe(200);

    // Only as a bearer token: the session cookie carries nothing for an app.
    const cookie = await call('GET', '/api/v1/threads', { cookie: `nova_session=${access}` });
    expect(cookie.status).toBe(401);

    // Allowed calls are summed per app and hour; refusals are audited one by one.
    expect(auditActions().filter((a) => a.action === 'app.calls')).toEqual([]);
    expect(await area.service.flushCalls(true)).toBe(1);
    const audit = auditActions();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'app.client.register',
        'app_authorization.create',
        'app.token.issue',
      ]),
    );
    const calls = audit.filter((a) => a.action === 'app.call');
    expect(calls.every((a) => a.decision === 'deny')).toBe(true);
    const summary = audit.find((a) => a.action === 'app.calls')!;
    expect(summary).toMatchObject({ decision: 'allow', result: '3' });
    expect(summary.detail).toMatchObject({
      clientId,
      calls: 3,
      errors: 0,
      routes: {
        'GET /api/v1/threads': 1,
        'GET /api/v1/threads/:id': 1,
        'GET /api/v1/projects': 1,
      },
    });
    expect(calls.find((a) => a.detail.route === '/api/v1/usage')).toMatchObject({
      decision: 'deny',
      result: '403',
    });
    // No token in the audit trail.
    expect(JSON.stringify(audit)).not.toContain(access.slice(4));
  });

  it('refreshes with rotation; a reused refresh token ends the chain', async () => {
    const { clientId, tokens } = await signIn();
    const next = await form('/api/v1/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      (await call('GET', '/api/v1/threads', bearer(next.body.access_token as string))).status,
    ).toBe(200);

    const reused = await form('/api/v1/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(reused).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const dead = await call('GET', '/api/v1/threads', bearer(next.body.access_token as string));
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe('token_required');
    expect(
      (
        await form('/api/v1/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: next.body.refresh_token as string,
          client_id: clientId,
        })
      ).body.error,
    ).toBe('invalid_grant');
    expect(auditActions().find((a) => a.action === 'app.token.reuse')).toMatchObject({
      decision: 'deny',
    });
  });

  it('revokes: the app its own chain (RFC 7009), the owner the whole app, through either list', async () => {
    const a = await signIn();
    const revoked = await form('/api/v1/oauth/revoke', {
      token: a.tokens.refresh_token as string,
      client_id: a.clientId,
    });
    expect(revoked.status).toBe(200);
    expect(
      (await call('GET', '/api/v1/threads', bearer(a.tokens.access_token as string))).status,
    ).toBe(401);
    // Unknown tokens answer 200 too.
    expect(
      (await form('/api/v1/oauth/revoke', { token: 'nva_nope', client_id: a.clientId })).status,
    ).toBe(200);

    const b = await signIn();
    const apps = await call('GET', '/api/v1/apps', t.owner.headers);
    // Oldest first; the first app revoked its only chain, so it has no live session.
    expect(apps.body.items).toEqual([
      expect.objectContaining({ clientId: a.clientId, sessions: 0 }),
      expect.objectContaining({
        clientId: b.clientId,
        name: 'Notes',
        scopes: ['projects:read', 'threads:read'],
        sessions: 1,
      }),
    ]);
    const grantB = (apps.body.items as WireJson[]).find((i) => i.clientId === b.clientId)!;
    // The M4 list shows the app as an MCP-shaped, read-only authorization of kind app.
    const m4 = await call('GET', '/api/v1/app-authorizations', t.owner.headers);
    expect((m4.body.items as WireJson[]).find((i) => i.id === grantB.id)).toMatchObject({
      kind: 'app',
      clientName: 'Notes',
      scopes: { tools: [], projects: '*', threads: 'read', mode: 'read_only' },
    });
    expect(
      (await call('DELETE', `/api/v1/apps/${grantB.id as string}`, t.owner.headers)).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/v1/threads', bearer(b.tokens.access_token as string))).status,
    ).toBe(401);
    expect(
      (
        await form('/api/v1/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: b.tokens.refresh_token as string,
          client_id: b.clientId,
        })
      ).body.error,
    ).toBe('invalid_grant');

    // The M4 revoke route works on apps as well.
    const c = await signIn();
    const grantC = (
      (await call('GET', '/api/v1/apps', t.owner.headers)).body.items as WireJson[]
    ).find((i) => i.clientId === c.clientId)!;
    expect(
      (await call('DELETE', `/api/v1/app-authorizations/${grantC.id as string}`, t.owner.headers))
        .status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/v1/threads', bearer(c.tokens.access_token as string))).status,
    ).toBe(401);
  });
});

describe('refusals', () => {
  it('refuses a wrong verifier and burns the code', async () => {
    const clientId = await registerApp();
    const { verifier, challenge } = pkce();
    const decided = await call('POST', '/api/v1/apps/authorize', t.owner.headers, {
      query: authorizeQuery(clientId, challenge),
      decision: 'approve',
    });
    const code = new URL(decided.body.redirectTo as string).searchParams.get('code')!;
    const fields = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
    };
    const wrong = await form('/api/v1/oauth/token', { ...fields, code_verifier: pkce().verifier });
    expect(wrong).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'code_verifier does not match' },
    });
    expect(
      (await form('/api/v1/oauth/token', { ...fields, code_verifier: verifier })).body.error,
    ).toBe('invalid_grant');
  });

  it('refuses a redirect URI mismatch at the consent and at the token endpoint', async () => {
    const clientId = await registerApp();
    const { verifier, challenge } = pkce();
    const mismatch = await call(
      'GET',
      `/api/v1/apps/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'http://127.0.0.1:53999/elsewhere' })}`,
      t.owner.headers,
    );
    expect(mismatch.status).toBe(400);
    // Never a redirect to an unverified URI.
    expect(mismatch.body.error.details).toEqual({ reason: 'redirect_uri_mismatch' });

    const decided = await call('POST', '/api/v1/apps/authorize', t.owner.headers, {
      query: authorizeQuery(clientId, challenge),
      decision: 'approve',
    });
    const res = await form('/api/v1/oauth/token', {
      grant_type: 'authorization_code',
      code: new URL(decided.body.redirectTo as string).searchParams.get('code')!,
      redirect_uri: 'http://127.0.0.1:54000/callback',
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'redirect_uri differs from the request',
    });
  });

  it('refuses non-loopback http and web redirects at registration, and RFC 7591 names work', async () => {
    for (const uri of [
      'http://192.168.1.20:8080/cb',
      'http://localhost/cb',
      'https://notes.example/cb',
    ]) {
      const res = await call(
        'POST',
        '/api/v1/apps/register',
        {},
        { name: 'X', redirectUris: [uri], scopes: ['threads:read'] },
      );
      expect(res.status, uri).toBe(400);
      expect(res.body.error.code).toBe('validation');
    }
    const rfc = await call(
      'POST',
      '/api/v1/apps/register',
      {},
      {
        client_name: 'Y',
        redirect_uris: ['com.example.y:/cb'],
        scope: 'usage:read',
        token_endpoint_auth_method: 'none',
      },
    );
    expect(rfc.status).toBe(201);
    expect(rfc.body).toMatchObject({
      client_name: 'Y',
      scope: 'usage:read',
      token_endpoint_auth_method: 'none',
    });
    expect(
      (
        await call(
          'POST',
          '/api/v1/apps/register',
          {},
          { client_name: 'Z', redirect_uris: ['com.example.z:/cb'], scope: 'admin' },
        )
      ).status,
    ).toBe(400);
  });

  it('answers token-endpoint mistakes in RFC 6749 form', async () => {
    const clientId = await registerApp();
    expect((await form('/api/v1/oauth/token', { client_id: clientId })).body.error).toBe(
      'invalid_request',
    );
    expect(
      (await form('/api/v1/oauth/token', { grant_type: 'password', client_id: clientId })).body
        .error,
    ).toBe('unsupported_grant_type');
    const repeated = await t.hub.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      headers: { ...HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=refresh_token&refresh_token=a&refresh_token=b&client_id=${clientId}`,
    });
    expect(repeated.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'refresh_token is repeated',
    });
    const unknown = await form('/api/v1/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'nva_x',
      client_id: 'nope',
    });
    expect(unknown).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    // JSON bodies work too.
    const json = await call(
      'POST',
      '/api/v1/oauth/token',
      {},
      { grant_type: 'refresh_token', refresh_token: 'nva_x', client_id: clientId },
    );
    expect(json).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('keeps members out of the consent and the list', async () => {
    const member = await t.join('Mia');
    const clientId = await registerApp();
    const q = authorizeQuery(clientId, pkce().challenge);
    for (const [method, url, payload] of [
      ['GET', `/api/v1/apps/authorize?${q}`, undefined],
      ['POST', '/api/v1/apps/authorize', { query: q, decision: 'approve' }],
      ['GET', '/api/v1/apps', undefined],
    ] as const) {
      const res = await call(method, url, member.headers, payload);
      expect(res.status, url).toBe(403);
      expect(res.body.error.details).toEqual({ reason: 'owner_only' });
    }
  });

  it('rate-limits registration per address', async () => {
    for (let i = 0; i < 10; i++) await registerApp();
    const res = await call(
      'POST',
      '/api/v1/apps/register',
      {},
      { name: 'N', redirectUris: ['http://127.0.0.1/cb'], scopes: ['threads:read'] },
    );
    expect(res.status).toBe(429);
  });
});

describe('turning apps off', () => {
  it('managed policy disables registration, consent, tokens and every existing token', async () => {
    const { clientId, tokens } = await signIn();
    // The policy restricts apps and, as the managed area does, locks the switch off too: the
    // refusal still names the policy.
    managed = {
      'managed.restrict': { layers: [{ apps: false }], failClosed: null },
      'apps.enabled': false,
    };
    const reg = await call(
      'POST',
      '/api/v1/apps/register',
      {},
      { name: 'X', redirectUris: ['http://127.0.0.1/cb'], scopes: ['threads:read'] },
    );
    expect(reg.status).toBe(403);
    expect(reg.body.error.details).toEqual({ reason: 'managed' });
    expect(
      (await call('GET', '/api/v1/threads', bearer(tokens.access_token as string))).status,
    ).toBe(401);
    const consent = await call(
      'GET',
      `/api/v1/apps/authorize?${authorizeQuery(clientId, pkce().challenge)}`,
      t.owner.headers,
    );
    expect(consent.status).toBe(403);
    expect(consent.body.error.details.reason).toBe('managed');
    expect(new URL(consent.body.error.details.redirectTo as string).searchParams.get('error')).toBe(
      'access_denied',
    );
    const refresh = await form('/api/v1/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(refresh.body.error).toBe('unauthorized_client');
    managed = {};
    expect(
      (await call('GET', '/api/v1/threads', bearer(tokens.access_token as string))).status,
    ).toBe(200);
  });

  it('the apps.enabled setting does the same', async () => {
    const { tokens } = await signIn();
    const off = await call('PATCH', '/api/v1/settings', t.owner.headers, {
      key: 'apps.enabled',
      value: false,
      scope: 'global',
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(
      (await call('GET', '/api/v1/threads', bearer(tokens.access_token as string))).status,
    ).toBe(401);
    const reg = await call(
      'POST',
      '/api/v1/apps/register',
      {},
      { name: 'X', redirectUris: ['http://127.0.0.1/cb'], scopes: ['threads:read'] },
    );
    expect(reg.body.error.details).toEqual({ reason: 'apps_disabled' });
  });
});

describe('pending registrations', () => {
  it('lists unapproved apps for the owner and deletes one; members and apps are refused', async () => {
    const clientId = await registerApp(['threads:read']);
    const signed = await signIn();
    const list = await call('GET', '/api/v1/apps/pending', t.owner.headers);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      {
        clientId,
        name: 'Notes',
        redirectHosts: ['127.0.0.1', 'com.example.notes'],
        scopes: ['threads:read'],
        registeredAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
    // Never a secret, and the authorized app is not in it.
    expect(JSON.stringify(list.body)).not.toContain('nva_');
    expect(JSON.stringify(list.body)).not.toContain(signed.clientId);

    const member = await t.join('Mia');
    for (const [method, url] of [
      ['GET', '/api/v1/apps/pending'],
      ['DELETE', `/api/v1/apps/pending/${clientId}`],
    ] as const) {
      const m = await call(method, url, member.headers);
      expect(m.status, url).toBe(403);
      expect(m.body.error.details).toEqual({ reason: 'owner_only' });
      const a = await call(method, url, bearer(signed.tokens.access_token as string));
      expect(a.status, url).toBe(403);
      expect(a.body.error.details).toEqual({ reason: 'not_app_scoped' });
      expect((await call(method, url, {})).status, url).toBe(401);
    }
    const busy = await call('DELETE', `/api/v1/apps/pending/${signed.clientId}`, t.owner.headers);
    expect(busy.status).toBe(409);
    expect(
      (await call('DELETE', `/api/v1/apps/pending/${clientId}`, t.owner.headers)).body,
    ).toEqual({ ok: true });
    expect((await call('GET', '/api/v1/apps/pending', t.owner.headers)).body.items).toEqual([]);
    expect(auditActions().some((a) => a.action === 'app.client.delete')).toBe(true);
  });
});

describe('listener hygiene', () => {
  it('needs a session on every apps route but the public ones, which refuse an empty body', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/apps/authorize?client_id=x'],
      ['POST', '/api/v1/apps/authorize'],
      ['GET', '/api/v1/apps'],
      ['DELETE', '/api/v1/apps/x'],
    ] as const) {
      const res = await call(
        method,
        url,
        {},
        method === 'GET' || method === 'DELETE' ? undefined : {},
      );
      expect(res.status, url).toBe(401);
      expect(res.body.error.code, url).toBe('token_required');
    }
    for (const url of ['/api/v1/apps/register', '/api/v1/oauth/token', '/api/v1/oauth/revoke']) {
      const res = await call('POST', url, {}, {});
      expect(res.status, url).toBe(400);
    }
  });

  it('keeps an app token off the event socket', async () => {
    const { tokens } = await signIn();
    const res = await call('GET', '/api/v1/ws', bearer(tokens.access_token as string));
    expect(res.status).toBe(403);
  });
});

describe('discovery', () => {
  it('publishes RFC 8414 metadata', async () => {
    const res = await call('GET', '/.well-known/oauth-authorization-server', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: `http://${HOST.host}`,
      authorization_endpoint: `http://${HOST.host}/authorize`,
      token_endpoint: `http://${HOST.host}/api/v1/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});
