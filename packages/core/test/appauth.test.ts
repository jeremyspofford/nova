// Third-party app authorization service (FR-222, ADR-097 D6): registration and its redirect
// rules, the authorization request's checks (which errors may redirect and which must not), the
// consent and its scopes, the code exchange with PKCE S256, refresh rotation and reuse detection,
// revocation by the app and by the owner, apps turned off, the M4 revoke path, and the sweep.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type OAuthTokenResponse } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  AppAuthService,
  MemoryEventSink,
  OAuthError,
  recordHubOwner,
  s256Challenge,
  type AppsAllowed,
  type AuditRecord,
} from '../src/index.ts';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const ISSUER = 'http://127.0.0.1:7419';
const VERIFIER = 'dBjftJeZ4CVP-mJ92K9qQ5bIGTJ8J1Mm4Ao6LrIovxA';
const CHALLENGE = s256Challenge(VERIFIER);

let db: NovaDatabase;
let events: MemoryEventSink;
let audit: AuditRecord[];
let allowed: AppsAllowed;
let clock: Date;
let svc: AppAuthService;

async function freshDb(): Promise<NovaDatabase> {
  const d = openDatabase({ path: ':memory:' });
  await migrate(d);
  return d;
}

beforeEach(async () => {
  db = await freshDb();
  const iso = '2026-10-19T09:00:00.000Z';
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(OWNER, iso, iso);
  recordHubOwner(db, OWNER, iso);
  events = new MemoryEventSink();
  audit = [];
  allowed = { ok: true };
  clock = new Date('2026-10-19T10:00:00.000Z');
  svc = new AppAuthService({
    db,
    events,
    allowed: () => Promise.resolve(allowed),
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    now: () => clock,
    maxPendingClients: 3,
  });
});

afterEach(() => db.close());

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function registerApp(over: { redirectUris?: string[]; scopes?: string[] } = {}) {
  return svc.register({
    name: 'Notes',
    redirectUris: over.redirectUris ?? ['http://127.0.0.1/callback', 'com.example.notes:/oauth'],
    scopes: (over.scopes ?? ['threads:read', 'projects:read', 'account:read']) as never,
  });
}

function query(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.append(k, v);
  return `?${q.toString()}`;
}

function request(clientId: string, over: Record<string, string | undefined> = {}): string {
  return query({
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:53111/callback',
    response_type: 'code',
    scope: 'threads:read projects:read',
    state: 'st-1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...over,
  });
}

function codeOf(redirectTo: string): string {
  return new URL(redirectTo).searchParams.get('code')!;
}

async function approved(clientId: string, scopes?: string[]): Promise<string> {
  const out = await svc.decide(
    OWNER,
    {
      query: request(clientId),
      decision: 'approve',
      ...(scopes ? { scopes: scopes as never } : {}),
    },
    ISSUER,
  );
  return codeOf(out.redirectTo);
}

async function exchange(
  clientId: string,
  code: string,
  over: Partial<{ verifier: string; redirectUri: string }> = {},
) {
  return svc.exchangeCode({
    code,
    clientId,
    codeVerifier: over.verifier ?? VERIFIER,
    redirectUri: over.redirectUri ?? 'http://127.0.0.1:53111/callback',
  });
}

async function oauthError(p: Promise<unknown>): Promise<OAuthError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthError);
  return err as OAuthError;
}

async function novaError(p: Promise<unknown>): Promise<NovaError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NovaError);
  return err as NovaError;
}

describe('registration', () => {
  it('registers a native app with loopback and private-scheme redirects, audited for the owner', async () => {
    const c = await registerApp();
    expect(c).toMatchObject({
      client_name: 'Notes',
      redirect_uris: ['http://127.0.0.1/callback', 'com.example.notes:/oauth'],
      scope: 'account:read projects:read threads:read',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(clock.getTime() / 1000),
    });
    expect(audit.find((a) => a.action === 'app.client.register')).toMatchObject({
      accountId: OWNER,
      actor: `app_client:${c.client_id}`,
      kind: 'auth',
    });
    expect(svc.counts()).toMatchObject({ clients: 1, pendingClients: 1, authorizations: 0 });
  });

  it.each([
    ['https://notes.example/callback', 'web_redirect'],
    ['http://192.168.1.5/callback', 'non_loopback_http'],
    ['http://localhost:8080/callback', 'non_loopback_http'],
    ['http://127.0.0.1/callback#frag', 'fragment'],
    ['http://user:pw@127.0.0.1/callback', 'credentials'],
    ['notes:/callback', 'scheme_not_reverse_domain'],
    ['javascript:alert(1)', 'scheme_not_reverse_domain'],
    ['Com.Example.Notes:/cb', 'scheme_not_reverse_domain'],
    ['not a uri', 'invalid_uri'],
  ])('refuses the redirect %s (%s)', async (uri, reason) => {
    const err = await novaError(registerApp({ redirectUris: [uri] }));
    expect(err.code).toBe('validation');
    expect(err.details).toEqual({ field: 'redirectUris', reason });
  });

  it('accepts an IPv6 loopback redirect', async () => {
    const c = await registerApp({ redirectUris: ['http://[::1]:9000/cb'] });
    expect(c.redirect_uris).toEqual(['http://[::1]:9000/cb']);
  });

  it('caps the clients nobody approved yet', async () => {
    for (let i = 0; i < 3; i++) await registerApp();
    const err = await novaError(registerApp());
    expect(err.code).toBe('rate_limited');
    expect(err.details).toEqual({ reason: 'too_many_pending_apps' });
  });

  it('refuses while apps are off, saying whether managed policy did it', async () => {
    allowed = { ok: false, reason: 'managed' };
    const err = await novaError(registerApp());
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ reason: 'managed' });
    allowed = { ok: false, reason: 'disabled' };
    expect((await novaError(registerApp())).details).toEqual({ reason: 'apps_disabled' });
  });
});

describe('the authorization request', () => {
  it('never redirects for an unknown client or an unregistered redirect', async () => {
    const { client_id } = await registerApp();
    const unknown = await novaError(svc.parseRequest(request('nope'), ISSUER));
    expect(unknown.code).toBe('not_found');
    expect(unknown.details).toEqual({ reason: 'unknown_client' });
    const missing = await novaError(
      svc.parseRequest(request(client_id, { redirect_uri: undefined }), ISSUER),
    );
    expect(missing.details).toEqual({ reason: 'redirect_uri_required' });
    for (const uri of [
      'http://127.0.0.1:53111/other',
      'http://127.0.0.1:53111/callback?x=1',
      'com.example.notes:/oauth/x',
      'https://evil.example/callback',
    ]) {
      const err = await novaError(
        svc.parseRequest(request(client_id, { redirect_uri: uri }), ISSUER),
      );
      expect(err.details, uri).toEqual({ reason: 'redirect_uri_mismatch' });
    }
    const twice = await novaError(
      svc.parseRequest(`${request(client_id)}&client_id=${client_id}`, ISSUER),
    );
    expect(twice.details).toEqual({ reason: 'invalid_request' });
  });

  it('matches a loopback redirect on any port and a private scheme exactly', async () => {
    const { client_id } = await registerApp();
    const r1 = await svc.parseRequest(
      request(client_id, { redirect_uri: 'http://127.0.0.1:1/callback' }),
      ISSUER,
    );
    expect(r1.redirectKind).toBe('loopback');
    const r2 = await svc.parseRequest(
      request(client_id, { redirect_uri: 'com.example.notes:/oauth' }),
      ISSUER,
    );
    expect(r2.redirectKind).toBe('private_scheme');
  });

  it.each([
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ scope: 'threads:read usage:read' }, 'invalid_scope'],
    [{ scope: 'threads:write' }, 'invalid_scope'],
    [{ scope: '' }, 'invalid_scope'],
    [{ state: 'x'.repeat(501) }, 'invalid_request'],
  ])('sends %j back to the app as %s', async (over, error) => {
    const { client_id } = await registerApp();
    const err = await novaError(svc.parseRequest(request(client_id, over), ISSUER));
    expect(err.code).toBe('validation');
    expect((err.details as { reason: string }).reason).toBe(error);
    const back = new URL((err.details as { redirectTo: string }).redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe('http://127.0.0.1:53111/callback');
    expect(back.searchParams.get('error')).toBe(error);
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    // A state too long to echo is left out.
    expect(back.searchParams.get('state')).toBe('state' in over ? null : 'st-1');
  });

  it('refuses a repeated parameter and answers access_denied while apps are off', async () => {
    const { client_id } = await registerApp();
    const twice = await novaError(svc.parseRequest(`${request(client_id)}&scope=x`, ISSUER));
    expect(twice.details).toMatchObject({ reason: 'invalid_request' });
    allowed = { ok: false, reason: 'managed' };
    const off = await novaError(svc.parseRequest(request(client_id), ISSUER));
    expect(off.code).toBe('policy_denied');
    expect((off.details as { reason: string }).reason).toBe('managed');
    expect(
      new URL((off.details as { redirectTo: string }).redirectTo).searchParams.get('error'),
    ).toBe('access_denied');
    allowed = { ok: false, reason: 'disabled' };
    const disabled = await novaError(svc.parseRequest(request(client_id), ISSUER));
    expect((disabled.details as { reason: string }).reason).toBe('apps_disabled');
  });

  it('defaults to the registered scopes and shows them in plain words', async () => {
    const { client_id } = await registerApp();
    const view = await svc.consent(OWNER, request(client_id, { scope: undefined }), ISSUER);
    expect(view.scopes.map((s) => s.scope)).toEqual([
      'account:read',
      'projects:read',
      'threads:read',
    ]);
    expect(view.scopes[2]).toMatchObject({ label: 'Read your chats', granted: false });
    expect(view).toMatchObject({
      authorized: false,
      client: { name: 'Notes', redirectKind: 'loopback' },
    });
  });
});

describe('consent, code and tokens', () => {
  it('runs the whole flow: approve, exchange, call, refresh with rotation', async () => {
    const { client_id } = await registerApp();
    const out = await svc.decide(OWNER, { query: request(client_id), decision: 'approve' }, ISSUER);
    const back = new URL(out.redirectTo);
    expect(back.searchParams.get('state')).toBe('st-1');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect(events.events.find((e) => e.name === 'app.authorization.changed')?.payload).toEqual({
      authorizationId: out.authorizationId,
      kind: 'app',
      clientName: 'Notes',
      status: 'active',
    });
    expect(audit.find((a) => a.action === 'app_authorization.create')).toMatchObject({
      resource: `app_authorization:${out.authorizationId}`,
      detail: { kind: 'app', clientId: client_id, scopes: ['projects:read', 'threads:read'] },
    });
    // The M4 list reads the row as an MCP-shaped, read-only authorization.
    const row = db.raw
      .prepare('SELECT kind, status, scopes, token_hash FROM app_authorization WHERE id = ?')
      .get(out.authorizationId) as {
      kind: string;
      status: string;
      scopes: string;
      token_hash: string;
    };
    expect(row).toMatchObject({ kind: 'app', status: 'active' });
    expect(JSON.parse(row.scopes)).toEqual({
      tools: [],
      projects: '*',
      threads: 'read',
      mode: 'read_only',
      app: ['projects:read', 'threads:read'],
    });

    const tokens = await exchange(client_id, codeOf(out.redirectTo));
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'projects:read threads:read',
    });
    expect(tokens.access_token).toMatch(/^nva_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^nva_/);
    // Only hashes are stored.
    const stored = db.raw.prepare('SELECT token_hash FROM app_token').all() as {
      token_hash: string;
    }[];
    expect(stored.map((s) => s.token_hash)).not.toContain(tokens.access_token);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM app_token').all())).not.toContain(
      tokens.access_token.slice(4),
    );

    const id = await svc.verifyAccess(tokens.access_token);
    expect(id).toMatchObject({
      accountId: OWNER,
      authorizationId: out.authorizationId,
      clientId: client_id,
      clientName: 'Notes',
      scopes: ['projects:read', 'threads:read'],
    });
    // A refresh token is not an access token.
    expect(await svc.verifyAccess(tokens.refresh_token)).toBeNull();
    expect(
      (
        db.raw
          .prepare('SELECT last_used_at FROM app_authorization WHERE id = ?')
          .get(out.authorizationId) as {
          last_used_at: string;
        }
      ).last_used_at,
    ).toBe(clock.toISOString());

    advance(10_000);
    const next = await svc.refresh({ refreshToken: tokens.refresh_token, clientId: client_id });
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await svc.verifyAccess(next.access_token)).not.toBeNull();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['app.token.issue', 'app.token.refresh']),
    );
    expect(svc.listGrants(OWNER)).toEqual([
      expect.objectContaining({
        id: out.authorizationId,
        clientId: client_id,
        name: 'Notes',
        sessions: 1,
      }),
    ]);

    // The access token expires after an hour.
    advance(3600_000);
    expect(await svc.verifyAccess(next.access_token)).toBeNull();
  });

  it('revokes the whole chain when a used refresh token comes back', async () => {
    const { client_id } = await registerApp();
    const first = await exchange(client_id, await approved(client_id));
    const second = await svc.refresh({ refreshToken: first.refresh_token, clientId: client_id });
    const third = await svc.refresh({ refreshToken: second.refresh_token, clientId: client_id });
    const err = await oauthError(
      svc.refresh({ refreshToken: first.refresh_token, clientId: client_id }),
    );
    expect(err).toMatchObject({ error: 'invalid_grant', status: 400 });
    expect(await svc.verifyAccess(third.access_token)).toBeNull();
    expect(
      (await oauthError(svc.refresh({ refreshToken: third.refresh_token, clientId: client_id })))
        .error,
    ).toBe('invalid_grant');
    expect(audit.find((a) => a.action === 'app.token.reuse')).toMatchObject({
      decision: 'deny',
      detail: { what: 'refresh_token', tokensRevoked: 6 },
    });
    expect(svc.listGrants(OWNER)[0]!.sessions).toBe(0);
  });

  it('refuses a wrong verifier and burns the code', async () => {
    const { client_id } = await registerApp();
    const code = await approved(client_id);
    const wrong = await oauthError(exchange(client_id, code, { verifier: 'x'.repeat(43) }));
    expect(wrong.error).toBe('invalid_grant');
    expect(wrong.message).toBe('code_verifier does not match');
    expect((await oauthError(exchange(client_id, code))).error).toBe('invalid_grant');
    const malformed = await oauthError(
      exchange(client_id, await approved(client_id), { verifier: 'short' }),
    );
    expect(malformed.error).toBe('invalid_request');
  });

  it('refuses a redirect URI mismatch, an expired code, another client and an unknown client', async () => {
    const { client_id } = await registerApp();
    const other = (await registerApp()).client_id;
    const mismatch = await oauthError(
      exchange(client_id, await approved(client_id), {
        redirectUri: 'http://127.0.0.1:53112/callback',
      }),
    );
    expect(mismatch.message).toBe('redirect_uri differs from the request');
    const code = await approved(client_id);
    advance(301_000);
    expect((await oauthError(exchange(client_id, code))).message).toBe('the code expired');
    expect((await oauthError(exchange(other, await approved(client_id)))).error).toBe(
      'invalid_grant',
    );
    const unknown = await oauthError(exchange('nope', 'x'));
    expect(unknown).toMatchObject({ error: 'invalid_client', status: 401 });
    expect(unknown.toJSON()).toEqual({
      error: 'invalid_client',
      error_description: 'unknown client_id',
    });
  });

  it('revokes what a code issued when the code is used twice', async () => {
    const { client_id } = await registerApp();
    const code = await approved(client_id);
    const tokens = await exchange(client_id, code);
    expect((await oauthError(exchange(client_id, code))).message).toBe('the code was already used');
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    expect(audit.find((a) => a.action === 'app.token.reuse')?.detail).toMatchObject({
      what: 'code',
    });
  });

  it('denies with access_denied and keeps only the scopes the owner kept', async () => {
    const { client_id } = await registerApp();
    const denied = await svc.decide(OWNER, { query: request(client_id), decision: 'deny' }, ISSUER);
    expect(new URL(denied.redirectTo).searchParams.get('error')).toBe('access_denied');
    expect(denied.authorizationId).toBeNull();
    expect(audit.find((a) => a.action === 'app.authorize.deny')).toBeDefined();
    const extra = await novaError(
      svc.decide(
        OWNER,
        { query: request(client_id), decision: 'approve', scopes: ['usage:read'] },
        ISSUER,
      ),
    );
    expect(extra.details).toEqual({ field: 'scopes', reason: 'not_requested' });
    const tokens = await exchange(client_id, await approved(client_id, ['threads:read']));
    expect(tokens.scope).toBe('threads:read');
  });

  it('adds scopes on a second approval and narrows on refresh, never widens', async () => {
    const { client_id } = await registerApp();
    const a = await exchange(client_id, await approved(client_id, ['threads:read']));
    const b = await exchange(client_id, await approved(client_id, ['projects:read']));
    expect(audit.filter((x) => x.action === 'app_authorization.update')).toHaveLength(1);
    expect(svc.listGrants(OWNER)).toEqual([
      expect.objectContaining({ scopes: ['projects:read', 'threads:read'], sessions: 2 }),
    ]);
    // Each chain keeps the scopes its own approval granted.
    expect((await svc.verifyAccess(a.access_token))?.scopes).toEqual(['threads:read']);
    expect((await svc.verifyAccess(b.access_token))?.scopes).toEqual(['projects:read']);
    const view = await svc.consent(OWNER, request(client_id), ISSUER);
    expect(view.authorized).toBe(true);
    expect(view.scopes.every((s) => s.granted)).toBe(true);
    const wider = await oauthError(
      svc.refresh({
        refreshToken: a.refresh_token,
        clientId: client_id,
        scope: 'threads:read projects:read',
      }),
    );
    expect(wider.error).toBe('invalid_scope');
    expect(
      (
        await oauthError(
          svc.refresh({ refreshToken: a.refresh_token, clientId: client_id, scope: 'x' }),
        )
      ).error,
    ).toBe('invalid_scope');
    const two = await exchange(client_id, await approved(client_id));
    const narrow = await svc.refresh({
      refreshToken: two.refresh_token,
      clientId: client_id,
      scope: 'threads:read',
    });
    expect(narrow.scope).toBe('threads:read');
  });
});

describe('revocation', () => {
  let client: string;
  let tokens: OAuthTokenResponse;
  let authorizationId: string;

  beforeEach(async () => {
    client = (await registerApp()).client_id;
    const out = await svc.decide(OWNER, { query: request(client), decision: 'approve' }, ISSUER);
    authorizationId = out.authorizationId!;
    tokens = await exchange(client, codeOf(out.redirectTo));
  });

  it('lets the app revoke its access token or its whole chain', async () => {
    await svc.revokeToken({ token: tokens.access_token, clientId: client });
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    const next = await svc.refresh({ refreshToken: tokens.refresh_token, clientId: client });
    await svc.revokeToken({ token: next.refresh_token, clientId: client });
    expect(await svc.verifyAccess(next.access_token)).toBeNull();
    expect(audit.filter((a) => a.action === 'app.token.revoke')).toHaveLength(2);
    // Unknown tokens are fine; another app's are refused.
    await svc.revokeToken({ token: 'nva_unknown', clientId: client });
    const fresh = await exchange(client, await approved(client));
    expect(
      (await oauthError(svc.revokeToken({ token: fresh.access_token, clientId: 'other' }))).error,
    ).toBe('unauthorized_client');
  });

  it('lets the owner revoke the app: every token stops, event and audit', async () => {
    await svc.revokeGrant(OWNER, authorizationId);
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    expect(
      (await oauthError(svc.refresh({ refreshToken: tokens.refresh_token, clientId: client })))
        .message,
    ).toBe('the refresh token was revoked');
    expect(events.events.at(-1)).toMatchObject({
      name: 'app.authorization.changed',
      payload: { authorizationId, kind: 'app', status: 'revoked' },
    });
    expect(audit.find((a) => a.action === 'app_authorization.revoke')?.detail).toMatchObject({
      tokensRevoked: 2,
    });
    expect(svc.listGrants(OWNER)).toEqual([]);
    expect((await novaError(svc.revokeGrant(OWNER, authorizationId))).code).toBe('not_found');
  });

  it('honours the M4 revoke path (the app-authorizations route only flips the row)', async () => {
    db.raw
      .prepare("UPDATE app_authorization SET status = 'revoked' WHERE id = ?")
      .run(authorizationId);
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    expect(
      (await oauthError(svc.refresh({ refreshToken: tokens.refresh_token, clientId: client })))
        .message,
    ).toBe('the authorization was revoked');
  });

  it('stops every token while apps are off, and the token endpoint says so', async () => {
    allowed = { ok: false, reason: 'managed' };
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    const err = await oauthError(
      svc.refresh({ refreshToken: tokens.refresh_token, clientId: client }),
    );
    expect(err.error).toBe('unauthorized_client');
    allowed = { ok: true };
    expect(await svc.verifyAccess(tokens.access_token)).not.toBeNull();
  });

  it('refuses a scope list that no longer intersects the grant', async () => {
    db.raw
      .prepare('UPDATE app_authorization SET scopes = ? WHERE id = ?')
      .run('{"app":["usage:read"]}', authorizationId);
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
    expect(
      (await oauthError(svc.refresh({ refreshToken: tokens.refresh_token, clientId: client })))
        .message,
    ).toBe('no scope is granted any more');
    // Unreadable scopes grant nothing.
    db.raw.prepare("UPDATE app_authorization SET scopes = '{' WHERE id = ?").run(authorizationId);
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
  });
});

describe('the Hub itself, pending registrations and owner registration', () => {
  function svcWith(over: Partial<ConstructorParameters<typeof AppAuthService>[0]> = {}) {
    return new AppAuthService({
      db,
      events,
      allowed: () => Promise.resolve(allowed),
      audit: { append: (r) => Promise.resolve(void audit.push(r)) },
      now: () => clock,
      maxPendingClients: 2,
      ...over,
    });
  }

  it('refuses redirects the Hub reserves, at registration and at consent, never redirecting', async () => {
    const seen: (string | null)[] = [];
    const s = svcWith({
      reservedRedirect: (uri, issuer) => {
        seen.push(issuer);
        return uri.port === '7419';
      },
    });
    const reg = await novaError(
      s.register({
        name: 'X',
        redirectUris: ['http://127.0.0.1:7419/cb'],
        scopes: ['threads:read'],
      }),
    );
    expect(reg.details).toEqual({ field: 'redirectUris', reason: 'hub_address' });
    const hubPath = await novaError(
      s.register({
        name: 'X',
        redirectUris: ['http://127.0.0.1/api/v1/x'],
        scopes: ['threads:read'],
      }),
    );
    expect(hubPath.details).toEqual({ field: 'redirectUris', reason: 'hub_path' });
    const { client_id } = await s.register({
      name: 'X',
      redirectUris: ['http://127.0.0.1/cb'],
      scopes: ['threads:read'],
    });
    for (const uri of ['http://127.0.0.1:7419/cb', 'http://127.0.0.1:7419/api/v1/x']) {
      const err = await novaError(
        s.parseRequest(request(client_id, { redirect_uri: uri, scope: 'threads:read' }), ISSUER),
      );
      expect(err.details, uri).toEqual({ reason: 'redirect_uri_reserved' });
    }
    expect(seen).toContain(ISSUER);
    expect(seen).toContain(null);
    await s.parseRequest(
      request(client_id, { redirect_uri: 'http://127.0.0.1:5000/cb', scope: 'threads:read' }),
      ISSUER,
    );
  });

  it('ages pending registrations out of the cap and lets the owner register past it', async () => {
    const s = svcWith({ pendingTtlMs: 60_000 });
    const first = await s.register({
      name: 'A',
      redirectUris: ['http://127.0.0.1/callback'],
      scopes: ['threads:read'],
    });
    await s.register({
      name: 'B',
      redirectUris: ['http://127.0.0.1/callback'],
      scopes: ['threads:read'],
    });
    expect(
      (
        await novaError(
          s.register({
            name: 'C',
            redirectUris: ['http://127.0.0.1/callback'],
            scopes: ['threads:read'],
          }),
        )
      ).code,
    ).toBe('rate_limited');
    const owned = await s.register(
      { name: 'O', redirectUris: ['http://127.0.0.1/callback'], scopes: ['threads:read'] },
      { byOwner: true },
    );
    expect(audit.at(-1)?.detail).toMatchObject({ byOwner: true });
    advance(61_000);
    // Expired pending registrations are unknown and free their place.
    expect(
      (await novaError(s.parseRequest(request(first.client_id, { scope: 'threads:read' }), ISSUER)))
        .details,
    ).toEqual({
      reason: 'unknown_client',
    });
    await s.register({
      name: 'D',
      redirectUris: ['http://127.0.0.1/callback'],
      scopes: ['threads:read'],
    });
    // The owner's registration counts as approved: it neither expires nor fills the cap.
    await s.parseRequest(request(owned.client_id, { scope: 'threads:read' }), ISSUER);
    expect(s.counts()).toMatchObject({ pendingClients: 1 });
  });

  it('lists the registrations no one authorizes and deletes them, never an authorized one', async () => {
    const s = svcWith({ pendingTtlMs: 60_000 });
    const self = await s.register({
      name: 'Self',
      redirectUris: ['http://127.0.0.1/callback', 'http://[::1]:9000/cb', 'com.example.self:/cb'],
      scopes: ['threads:read', 'account:read'],
    });
    advance(1000);
    const byOwner = await s.register(
      { name: 'Owned', redirectUris: ['http://127.0.0.1/callback'], scopes: ['threads:read'] },
      { byOwner: true },
    );
    advance(1000);
    const used = await s.register({
      name: 'Used',
      redirectUris: ['http://127.0.0.1/callback'],
      scopes: ['threads:read'],
    });
    const out = await s.decide(
      OWNER,
      { query: request(used.client_id, { scope: 'threads:read' }), decision: 'approve' },
      ISSUER,
    );
    expect(s.listPending()).toEqual([
      {
        clientId: byOwner.client_id,
        name: 'Owned',
        redirectHosts: ['127.0.0.1'],
        scopes: ['threads:read'],
        registeredAt: new Date(clock.getTime() - 1000).toISOString(),
        expiresAt: null,
      },
      {
        clientId: self.client_id,
        name: 'Self',
        redirectHosts: ['127.0.0.1', '[::1]:9000', 'com.example.self'],
        scopes: ['account:read', 'threads:read'],
        registeredAt: new Date(clock.getTime() - 2000).toISOString(),
        expiresAt: new Date(clock.getTime() - 2000 + 60_000).toISOString(),
      },
    ]);
    // An authorized app is not pending and cannot be deleted here.
    const busy = await novaError(s.deletePending(OWNER, used.client_id));
    expect(busy.code).toBe('conflict');
    expect(busy.details).toEqual({ reason: 'authorized' });
    // Once revoked it is listed again (it does not expire) and can be deleted with its rows.
    await s.revokeGrant(OWNER, out.authorizationId!);
    expect(s.listPending().map((p) => p.name)).toEqual(['Used', 'Owned', 'Self']);
    await s.deletePending(OWNER, used.client_id);
    await s.deletePending(OWNER, self.client_id);
    expect(audit.filter((a) => a.action === 'app.client.delete').map((a) => a.detail)).toEqual([
      { clientId: used.client_id, name: 'Used', wasPending: false },
      { clientId: self.client_id, name: 'Self', wasPending: true },
    ]);
    expect(s.listPending().map((p) => p.name)).toEqual(['Owned']);
    expect((await novaError(s.deletePending(OWNER, self.client_id))).code).toBe('not_found');
    // The revoked authorization stays for the audit trail.
    expect(
      db.raw.prepare('SELECT status FROM app_authorization WHERE id = ?').get(out.authorizationId),
    ).toEqual({ status: 'revoked' });
    // A lapsed registration is no longer listed.
    advance(61_000);
    await s.register(
      { name: 'Late', redirectUris: ['http://127.0.0.1/callback'], scopes: ['threads:read'] },
      { byOwner: false },
    );
    expect(s.listPending().map((p) => p.name)).toEqual(['Late', 'Owned']);
  });

  it('sums allowed calls per app and hour into one audit entry', async () => {
    const id = { accountId: OWNER, authorizationId: 'a1', clientId: 'c1', clientName: 'Notes' };
    for (let i = 0; i < 3; i++)
      svc.noteCall(id, { method: 'GET', route: '/api/v1/threads', status: 200 });
    svc.noteCall(id, { method: 'GET', route: '/api/v1/threads/:id', status: 404 });
    // The hour is not over: nothing yet.
    expect(await svc.flushCalls()).toBe(0);
    advance(3_600_000);
    svc.noteCall(id, { method: 'GET', route: '/api/v1/usage', status: 200 });
    expect(await svc.flushCalls()).toBe(1);
    expect(audit.filter((a) => a.action === 'app.calls')).toEqual([
      expect.objectContaining({
        decision: 'allow',
        result: '4',
        detail: expect.objectContaining({
          hour: '2026-10-19T10:00:00.000Z',
          calls: 4,
          errors: 1,
          routes: { 'GET /api/v1/threads': 3, 'GET /api/v1/threads/:id': 1 },
        }),
      }),
    ]);
    expect(await svc.flushCalls(true)).toBe(1);
    // Routes past the cap are counted but not listed.
    for (let i = 0; i < 60; i++) svc.noteCall(id, { method: 'GET', route: `/r${i}`, status: 200 });
    await svc.flushCalls(true);
    const last = audit.filter((a) => a.action === 'app.calls').at(-1)!;
    expect(last.detail).toMatchObject({ calls: 60 });
    expect(Object.keys(last.detail!.routes as object)).toHaveLength(50);
  });
});

describe('sweep', () => {
  it('drops expired codes and tokens and clients nobody approved within a day', async () => {
    const kept = (await registerApp()).client_id;
    const dropped = (await registerApp()).client_id;
    const tokens = await exchange(kept, await approved(kept));
    await approved(kept); // an unused code
    advance(32 * 86_400_000);
    const out = await svc.sweep();
    expect(out).toEqual({ codes: 2, tokens: 2, clients: 1 });
    const ids = (db.raw.prepare('SELECT id FROM app_client').all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toEqual([kept]);
    expect(ids).not.toContain(dropped);
    expect(await svc.verifyAccess(tokens.access_token)).toBeNull();
  });
});
