// The OAuth state for remote MCP servers (FR-047): a flow from start to callback, single-use and
// expiring state, refusals, refresh before expiry and after a 401, failures, revocation and the
// settings view. Tokens live only in the (in-memory) vault.
import { afterEach, describe, expect, it } from 'vitest';
import { McpOAuthService, oauthRefs, type OAuthRecord } from '../src/index.ts';
import { startFakeAuthServer, type FakeAuthServer } from './oauth-fixture.ts';

const REDIRECT = 'http://127.0.0.1:7419/api/v1/mcp/oauth/callback';

let as: FakeAuthServer | null = null;
afterEach(async () => {
  await as?.close();
  as = null;
});

function env(opts: { now?: () => Date; stateTtlMs?: number } = {}) {
  const vault = new Map<string, string>();
  const saved: OAuthRecord[] = [];
  const removed: string[] = [];
  const changes: string[] = [];
  const svc = new McpOAuthService({
    vault: {
      put: (r, v) => Promise.resolve(void vault.set(r, v)),
      get: (r) => Promise.resolve(vault.get(r) ?? null),
      delete: (r) => Promise.resolve(vault.delete(r)),
    },
    store: {
      save: (r) => Promise.resolve(void saved.push(structuredClone(r))),
      remove: (id) => Promise.resolve(void removed.push(id)),
    },
    onChange: (id) => changes.push(id),
    ...opts,
  });
  return { svc, vault, saved, removed, changes };
}

async function connect(e: ReturnType<typeof env>, server: FakeAuthServer, id = 'srv-1') {
  const { authorizeUrl } = await e.svc.start({
    serverId: id,
    accountId: 'acct-1',
    serverUrl: server.mcpUrl,
    redirectUrl: REDIRECT,
    clientMetadataUrl: null,
  });
  const back = await server.authorize(authorizeUrl);
  const state = back.searchParams.get('state')!;
  const result = await e.svc.finish({ state, code: back.searchParams.get('code') ?? undefined });
  return { authorizeUrl, state, result };
}

describe('McpOAuthService', () => {
  it('runs the flow and keeps tokens only in the vault', async () => {
    as = await startFakeAuthServer();
    const e = env();
    expect(e.svc.view('srv-1')).toBeNull();
    expect(e.svc.provider('srv-1')).toBeNull();
    const { result } = await connect(e, as);
    expect(result).toEqual({ serverId: 'srv-1', accountId: 'acct-1', ok: true, error: null });
    expect(e.changes).toEqual(['srv-1']);
    expect(e.svc.view('srv-1')).toMatchObject({
      kind: 'oauth',
      status: 'connected',
      scopes: ['read', 'write'],
    });
    const token = await e.svc.provider('srv-1')!.token();
    expect(token).toMatch(/^at-/);
    expect(e.vault.get(oauthRefs('srv-1').access)).toBe(token);
    // Records reference the vault; no token value is ever saved with them.
    expect(JSON.stringify(e.saved)).not.toContain(token);
    expect(e.saved.at(-1)).toMatchObject({
      registration: 'dynamic',
      clientId: 'dyn-1',
      status: 'connected',
    });
  });

  it('uses each state once and refuses unknown or expired ones', async () => {
    as = await startFakeAuthServer();
    let now = Date.now();
    const e = env({ now: () => new Date(now), stateTtlMs: 1000 });
    const { state } = await connect(e, as);
    await expect(e.svc.finish({ state, code: 'again' })).rejects.toThrow(
      /unknown, used or expired/,
    );
    await expect(e.svc.finish({ state: 'made-up', code: 'x' })).rejects.toThrow(/unknown/);
    const { authorizeUrl } = await e.svc.start({
      serverId: 'srv-1',
      accountId: 'acct-1',
      serverUrl: as.mcpUrl,
      redirectUrl: REDIRECT,
      clientMetadataUrl: null,
    });
    // The registration is reused for the same authorization server.
    expect(as.registrations).toHaveLength(1);
    const late = new URL(authorizeUrl).searchParams.get('state')!;
    now += 5000;
    await expect(e.svc.finish({ state: late, code: 'x' })).rejects.toThrow(/expired/);
  });

  it('records a refused authorization and a bad code', async () => {
    as = await startFakeAuthServer();
    const e = env();
    const { authorizeUrl } = await e.svc.start({
      serverId: 'srv-2',
      accountId: 'acct-1',
      serverUrl: as.mcpUrl,
      redirectUrl: REDIRECT,
      clientMetadataUrl: null,
    });
    const back = await as.authorize(authorizeUrl, { deny: true });
    const r = await e.svc.finish({
      state: back.searchParams.get('state')!,
      error: back.searchParams.get('error') ?? undefined,
    });
    expect(r).toMatchObject({ ok: false, error: 'authorization was refused (access_denied)' });
    expect(e.svc.view('srv-2')!.status).toBe('error');
    const again = await e.svc.start({
      serverId: 'srv-2',
      accountId: 'acct-1',
      serverUrl: as.mcpUrl,
      redirectUrl: REDIRECT,
      clientMetadataUrl: null,
    });
    const s2 = new URL(again.authorizeUrl).searchParams.get('state')!;
    expect(await e.svc.finish({ state: s2, code: 'not-a-code' })).toMatchObject({ ok: false });
  });

  it('refreshes before expiry, single-flight, and after a 401', async () => {
    as = await startFakeAuthServer({ accessTtl: 30 });
    const e = env();
    await connect(e, as);
    const first = e.vault.get(oauthRefs('srv-1').access)!;
    // 30 s lifetime is inside the 60 s skew: the next request refreshes first.
    const [a, b] = await Promise.all([e.svc.accessToken('srv-1'), e.svc.accessToken('srv-1')]);
    expect(a).not.toBe(first);
    expect(a).toBe(b);
    expect(as.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(1);
    await e.svc.provider('srv-1')!.onUnauthorized!({} as never);
    expect(as.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2);
  });

  it('marks the tokens expired when refresh is refused', async () => {
    as = await startFakeAuthServer();
    const e = env();
    await connect(e, as);
    e.vault.set(oauthRefs('srv-1').refresh, 'rt-revoked');
    await e.svc.accessToken('srv-1', { force: true });
    expect(e.svc.view('srv-1')!.status).toBe('expired');
    // Without a refresh token an expired access token stays expired.
    e.vault.delete(oauthRefs('srv-1').refresh);
    await e.svc.accessToken('srv-1', { force: true });
    expect(e.svc.view('srv-1')!.status).toBe('expired');
  });

  it('revokes at the server, forgets the tokens and needs authorizing again', async () => {
    as = await startFakeAuthServer();
    const e = env();
    await connect(e, as);
    const refresh = e.vault.get(oauthRefs('srv-1').refresh)!;
    await e.svc.revoke('srv-1');
    expect(as.revoked).toContain(refresh);
    expect(e.vault.has(oauthRefs('srv-1').access)).toBe(false);
    expect(e.svc.view('srv-1')).toMatchObject({ status: 'needs_auth', expiresAt: null });
    expect(await e.svc.accessToken('srv-1')).toBeUndefined();
    await e.svc.revoke('missing');
    await e.svc.forget('srv-1');
    expect(e.svc.view('srv-1')).toBeNull();
    expect(e.removed).toEqual(['srv-1']);
  });

  it('loads saved records and reports expiry without a refresh token', () => {
    const rec: OAuthRecord = {
      serverId: 'old',
      accountId: 'acct-1',
      issuer: 'http://127.0.0.1:1',
      metadata: { issuer: 'http://127.0.0.1:1' } as OAuthRecord['metadata'],
      resource: null,
      clientId: 'c',
      clientSecretRef: null,
      registration: 'dynamic',
      scopes: [],
      accessTokenRef: oauthRefs('old').access,
      refreshTokenRef: null,
      status: 'connected',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const svc = new McpOAuthService({
      vault: {
        put: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        delete: () => Promise.resolve(),
      },
      store: { save: () => Promise.resolve(), remove: () => Promise.resolve() },
      records: [rec],
    });
    expect(svc.record('old')).toBe(rec);
    expect(svc.view('old')!.status).toBe('expired');
  });
});
