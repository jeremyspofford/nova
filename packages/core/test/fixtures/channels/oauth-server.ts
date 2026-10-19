// A fake OAuth 2 provider for the email OAuth tests (offline, 127.0.0.1): an authorization
// endpoint that consents at once (302 back to the redirect URI with a code, or an error), a token
// endpoint for the authorization code (PKCE S256 checked, single-use codes, the redirect URI
// matched, the client authenticated by `client_secret_post` or Basic) and refresh grants, and an
// RFC 7009 revocation endpoint. `valid` tells the fake mail servers which access tokens work.
// `testFlows` implements ChannelOAuthFlows over plain fetch for the core tests (the Hub uses the
// MCP OAuth helpers).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChannelOAuthFlows, ChannelOAuthTokens } from '../../../src/index.ts';

export interface FakeOAuth {
  base: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  clientId: string;
  clientSecret: string | null;
  /** Seconds an access token lives. */
  lifetime: number;
  /** Whether an access token works now. */
  valid(token: string): boolean;
  /** The newest access token handed out. */
  lastAccess(): string | null;
  /** The provider drops an access token early (mail servers refuse it). */
  dropAccess(token: string): void;
  /** Refresh tokens are refused from now on (`invalid_grant`). */
  refuseRefresh: boolean;
  /** The next token call fails with a server error. */
  failNext: boolean;
  /** The authorization endpoint answers `error=access_denied`. */
  deny: boolean;
  /** Rotate refresh tokens on refresh (default: send none, the old one stays valid). */
  rotate: boolean;
  tokenCalls: { grant: string; clientAuth: 'post' | 'basic' | 'none' }[];
  authorizeCalls: URLSearchParams[];
  revoked: string[];
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function startFakeOAuth(
  opts: { clientId?: string; clientSecret?: string | null; lifetime?: number } = {},
): Promise<FakeOAuth> {
  const clientId = opts.clientId ?? 'nova-mail-client';
  const clientSecret = opts.clientSecret === undefined ? 'fake-client-secret-1' : opts.clientSecret;
  const codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  let seq = 0;
  let newest: string | null = null;
  const state: FakeOAuth = {
    base: '',
    authUrl: '',
    tokenUrl: '',
    revokeUrl: '',
    clientId,
    clientSecret,
    lifetime: opts.lifetime ?? 3600,
    valid: (t) => access.has(t),
    lastAccess: () => newest,
    dropAccess: (t) => access.delete(t),
    refuseRefresh: false,
    failNext: false,
    deny: false,
    rotate: false,
    tokenCalls: [],
    authorizeCalls: [],
    revoked: [],
    close: () => Promise.resolve(),
  };
  const issue = (scope: string, withRefresh: boolean) => {
    seq++;
    const at = `fake-access-${seq}-${b64url(randomBytes(6))}`;
    access.add(at);
    newest = at;
    const body: Record<string, unknown> = {
      access_token: at,
      token_type: 'Bearer',
      expires_in: state.lifetime,
      scope,
    };
    if (withRefresh) {
      const rt = `fake-refresh-${seq}-${b64url(randomBytes(6))}`;
      refresh.add(rt);
      body.refresh_token = rt;
    }
    return body;
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const q = url.searchParams;
        state.authorizeCalls.push(q);
        const redirect = q.get('redirect_uri');
        if (!redirect) return json(400, { error: 'invalid_request' });
        const back = new URL(redirect);
        back.searchParams.set('state', q.get('state') ?? '');
        if (
          state.deny ||
          q.get('client_id') !== clientId ||
          q.get('response_type') !== 'code' ||
          q.get('code_challenge_method') !== 'S256' ||
          !q.get('code_challenge')
        )
          back.searchParams.set('error', state.deny ? 'access_denied' : 'invalid_request');
        else {
          const code = b64url(randomBytes(16));
          codes.set(code, {
            challenge: q.get('code_challenge')!,
            redirectUri: redirect,
            scope: q.get('scope') ?? '',
          });
          back.searchParams.set('code', code);
        }
        res.writeHead(302, { location: back.href });
        res.end();
        return;
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (req.method === 'POST' && url.pathname === '/revoke') {
        const t = form.get('token') ?? '';
        state.revoked.push(t);
        access.delete(t);
        refresh.delete(t);
        return json(200, {});
      }
      if (req.method !== 'POST' || url.pathname !== '/token') return json(404, { error: 'nope' });
      // The client: client_secret_post, Basic, or a public client (none).
      const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
      let id = form.get('client_id');
      let secret = form.get('client_secret');
      let clientAuth: 'post' | 'basic' | 'none' = secret ? 'post' : 'none';
      if (basic) {
        const [u, p] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
        id = decodeURIComponent(u ?? '');
        secret = decodeURIComponent(p ?? '');
        clientAuth = 'basic';
      }
      const grant = form.get('grant_type') ?? '';
      state.tokenCalls.push({ grant, clientAuth });
      if (state.failNext) {
        state.failNext = false;
        return json(500, { error: 'server_error', error_description: 'try later' });
      }
      if (id !== clientId || (clientSecret !== null && secret !== clientSecret))
        return json(401, { error: 'invalid_client' });
      if (grant === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        if (!code || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri'))
          return json(400, { error: 'invalid_grant', error_description: 'bad code' });
        return json(200, issue(code.scope, true));
      }
      if (grant === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        if (state.refuseRefresh || !refresh.has(rt))
          return json(400, {
            error: 'invalid_grant',
            error_description: 'token expired or revoked',
          });
        if (state.rotate) refresh.delete(rt);
        return json(200, issue('https://mail.example/', state.rotate));
      }
      return json(400, { error: 'unsupported_grant_type' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(state, {
    base,
    authUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return state;
}

/** Follow the provider's consent page to the redirect, as a browser would: the callback query. */
export async function consent(authorizeUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`no redirect (${res.status})`);
  return new URL(location).searchParams;
}

/** ChannelOAuthFlows over plain fetch (client_secret_post), for the core tests. */
export function testFlows(now: () => Date): ChannelOAuthFlows & { verifiers: string[] } {
  const verifiers: string[] = [];
  const token = async (
    tokenUrl: string,
    params: Record<string, string>,
  ): Promise<ChannelOAuthTokens> => {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    if (!res.ok) throw new Error(`${text(body.error)}: ${text(body.error_description)}`);
    return {
      accessToken: String(body.access_token),
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt:
        typeof body.expires_in === 'number'
          ? new Date(now().getTime() + body.expires_in * 1000).toISOString()
          : null,
      scopes: text(body.scope).split(' ').filter(Boolean),
    };
  };
  const client = (e: { clientId: string; clientSecret: string | null }): Record<string, string> =>
    e.clientSecret
      ? { client_id: e.clientId, client_secret: e.clientSecret }
      : { client_id: e.clientId };
  return {
    verifiers,
    begin: (_accountId, e, o) => {
      const verifier = b64url(randomBytes(32));
      verifiers.push(verifier);
      const u = new URL(e.authUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', e.clientId);
      u.searchParams.set('redirect_uri', o.redirectUri);
      u.searchParams.set('state', o.state);
      u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
      u.searchParams.set('code_challenge_method', 'S256');
      if (e.scopes.length) u.searchParams.set('scope', e.scopes.join(' '));
      return Promise.resolve({ authorizeUrl: u.href, codeVerifier: verifier });
    },
    complete: (_accountId, e, o) =>
      token(e.tokenUrl, {
        grant_type: 'authorization_code',
        code: o.code,
        code_verifier: o.codeVerifier,
        redirect_uri: o.redirectUri,
        ...client(e),
      }),
    refresh: (_accountId, e, refreshToken) =>
      token(e.tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, ...client(e) }),
    revoke: async (_accountId, e, t, hint) => {
      if (!e.revokeUrl) return false;
      const res = await fetch(e.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t, token_type_hint: hint, ...client(e) }),
      });
      return res.ok;
    },
  };
}
