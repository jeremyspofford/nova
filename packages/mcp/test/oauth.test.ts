// OAuth for remote MCP servers (FR-047) against the in-process authorization server: discovery,
// registration by client metadata document or dynamic registration, PKCE codes, refresh,
// revocation, and the connection asking a token provider before each request.
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAuthorization,
  clientMetadataDocument,
  completeAuthorization,
  discoverOAuth,
  refreshOAuth,
  registerOAuthClient,
  revokeOAuth,
  type McpServerConfig,
} from '../src/index.ts';
import { harness, waitFor, type Harness } from './helpers.ts';
import { startFakeAuthServer, type FakeAuthServer } from './oauth-fixture.ts';

let as: FakeAuthServer | null = null;
let h: Harness | null = null;
afterEach(async () => {
  await h?.manager.close();
  await as?.close();
  as = null;
  h = null;
});

const REDIRECT = 'http://127.0.0.1:7419/api/v1/mcp/oauth/callback';

async function signIn(server: FakeAuthServer) {
  const d = await discoverOAuth(server.mcpUrl);
  const client = await registerOAuthClient(d, {
    clientMetadataUrl: null,
    redirectUrl: REDIRECT,
    scopes: [],
  });
  const { authorizeUrl, codeVerifier } = await beginAuthorization(d, client, {
    redirectUrl: REDIRECT,
    state: 'state-1',
    scopes: ['read'],
  });
  const back = await server.authorize(authorizeUrl);
  const tokens = await completeAuthorization(d, client, {
    code: back.searchParams.get('code')!,
    codeVerifier,
    redirectUrl: REDIRECT,
    scopes: ['read'],
  });
  return { d, client, tokens, authorizeUrl: new URL(authorizeUrl), back };
}

describe('discovery and registration', () => {
  it('finds the authorization server and the resource from the server URL', async () => {
    as = await startFakeAuthServer();
    const d = await discoverOAuth(as.mcpUrl);
    expect(d.authorizationServerUrl.replace(/\/$/, '')).toBe(as.base);
    expect(d.resource).toBe(as.mcpUrl);
    expect(d.scopesSupported).toEqual(['read', 'write']);
    expect((d.metadata as { token_endpoint: string }).token_endpoint).toBe(`${as.base}/token`);
  });

  it('refuses an authorization server without PKCE S256', async () => {
    as = await startFakeAuthServer({ s256: false });
    await expect(discoverOAuth(as.mcpUrl)).rejects.toThrow(/PKCE/);
  });

  it('refuses a server that publishes no OAuth metadata', async () => {
    await expect(discoverOAuth('http://127.0.0.1:9/mcp')).rejects.toThrow(/discover|metadata/);
  });

  it('uses dynamic registration when there is no HTTPS client metadata URL', async () => {
    as = await startFakeAuthServer({ cimd: true });
    const d = await discoverOAuth(as.mcpUrl);
    const c = await registerOAuthClient(d, {
      clientMetadataUrl: 'http://127.0.0.1:7419/.well-known/nova-client.json',
      redirectUrl: REDIRECT,
      scopes: ['read'],
    });
    expect(c).toMatchObject({ clientId: 'dyn-1', method: 'dynamic', clientSecret: null });
    expect(as.registrations[0]).toMatchObject({
      client_name: 'Nova',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
  });

  it('uses the client metadata document when the server accepts one', async () => {
    as = await startFakeAuthServer({ cimd: true });
    const d = await discoverOAuth(as.mcpUrl);
    const url = 'https://hub.example/.well-known/nova-client.json';
    const c = await registerOAuthClient(d, {
      clientMetadataUrl: url,
      redirectUrl: REDIRECT,
      scopes: [],
    });
    expect(c).toEqual({ clientId: url, clientSecret: null, method: 'metadata_document' });
    expect(as.registrations).toHaveLength(0);
    expect(clientMetadataDocument(url, REDIRECT)).toMatchObject({
      client_id: url,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
    });
  });

  it('fails clearly when the server offers neither', async () => {
    as = await startFakeAuthServer({ dcr: false });
    const d = await discoverOAuth(as.mcpUrl);
    await expect(
      registerOAuthClient(d, { clientMetadataUrl: null, redirectUrl: REDIRECT, scopes: [] }),
    ).rejects.toThrow(/dynamic registration/);
  });
});

describe('authorization code with PKCE', () => {
  it('builds an S256 authorization URL and exchanges the code', async () => {
    as = await startFakeAuthServer();
    const { tokens, authorizeUrl, back } = await signIn(as);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('state')).toBe('state-1');
    expect(authorizeUrl.searchParams.get('resource')).toBe(as.mcpUrl);
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(tokens.accessToken).toMatch(/^at-/);
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(new Date(tokens.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(as.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      resource: as.mcpUrl,
    });
  });

  it('refuses a wrong verifier or a reused code', async () => {
    as = await startFakeAuthServer();
    const d = await discoverOAuth(as.mcpUrl);
    const client = await registerOAuthClient(d, {
      clientMetadataUrl: null,
      redirectUrl: REDIRECT,
      scopes: [],
    });
    const { authorizeUrl, codeVerifier } = await beginAuthorization(d, client, {
      redirectUrl: REDIRECT,
      state: 's',
      scopes: [],
    });
    const code = (await as.authorize(authorizeUrl)).searchParams.get('code')!;
    await expect(
      completeAuthorization(d, client, {
        code,
        codeVerifier: 'x'.repeat(50),
        redirectUrl: REDIRECT,
        scopes: [],
      }),
    ).rejects.toThrow(/not accepted/);
    await expect(
      completeAuthorization(d, client, { code, codeVerifier, redirectUrl: REDIRECT, scopes: [] }),
    ).rejects.toThrow(/not accepted/);
  });

  it('refreshes, keeping the old refresh token when the server sends none', async () => {
    as = await startFakeAuthServer({ rotateRefresh: false });
    const { d, client, tokens } = await signIn(as);
    const next = await refreshOAuth(d, client, tokens.refreshToken!, { scopes: [] });
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(next.refreshToken).toBe(tokens.refreshToken);
    await expect(refreshOAuth(d, client, 'rt-unknown', { scopes: [] })).rejects.toThrow(
      /refreshed/,
    );
  });

  it('revokes at the revocation endpoint', async () => {
    as = await startFakeAuthServer();
    const { d, client, tokens } = await signIn(as);
    expect(await revokeOAuth(d, client, tokens.refreshToken!, 'refresh_token')).toBe(true);
    expect(as.revoked).toEqual([tokens.refreshToken]);
    const noEndpoint = { ...d, metadata: { ...d.metadata, revocation_endpoint: undefined } };
    expect(await revokeOAuth(noEndpoint, client, 'x', 'access_token')).toBe(false);
    const insecure = {
      ...d,
      metadata: { ...d.metadata, revocation_endpoint: 'http://auth.example/revoke' },
    };
    expect(await revokeOAuth(insecure, client, 'x', 'access_token')).toBe(false);
  });
});

describe('connections with a token provider', () => {
  function httpConfig(url: string): McpServerConfig {
    return {
      id: 'oauth-1',
      accountId: 'acct-1',
      name: 'remote',
      transport: 'http',
      command: null,
      args: [],
      url,
      env: {},
      headers: {},
      enabled: true,
      startupTimeoutMs: 5000,
      toolTimeoutMs: 5000,
      enabledTools: null,
      disabledTools: [],
    };
  }

  it('sends the current token and refreshes after a 401', async () => {
    as = await startFakeAuthServer();
    const { d, client, tokens } = await signIn(as);
    let current = tokens;
    let refreshes = 0;
    h = harness({
      authFor: (cfg) =>
        cfg.id === 'oauth-1'
          ? {
              token: () => Promise.resolve(current.accessToken),
              onUnauthorized: async () => {
                refreshes++;
                current = await refreshOAuth(d, client, current.refreshToken!, { scopes: [] });
              },
            }
          : null,
    });
    await h.manager.add(httpConfig(as.mcpUrl));
    expect(h.manager.state('oauth-1')!.status).toBe('connected');
    expect(as.bearers.every((b) => b === tokens.accessToken)).toBe(true);
    as.expire(tokens.accessToken);
    expect(await h.manager.callTool('oauth-1', 'echo', { text: 'hi' })).toMatchObject({ ok: true });
    expect(refreshes).toBe(1);
    expect(as.bearers.at(-1)).toBe(current.accessToken);
  });

  it('fails the connection without a token', async () => {
    as = await startFakeAuthServer();
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    await h.manager.add(httpConfig(as.mcpUrl));
    const s = await waitFor(() => h!.manager.state('oauth-1'), 5000);
    expect(s.status).toBe('error');
  });
});
