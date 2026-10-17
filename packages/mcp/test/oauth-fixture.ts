// An in-process OAuth 2.1 authorization server with a protected MCP endpoint, for the OAuth tests
// (FR-047): protected-resource and authorization-server metadata, dynamic registration, PKCE
// (S256) authorization codes, refresh, revocation, and `/mcp` serving the fixture server only to a
// valid bearer token. The "browser" step is `authorize(url)`, which returns the redirect.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createTestServer } from './fixtures/test-server.mjs';

export interface FakeAuthOptions {
  /** Offer dynamic client registration (default true). */
  dcr?: boolean;
  /** Accept client metadata documents (default false). */
  cimd?: boolean;
  /** Advertise PKCE S256 (default true). */
  s256?: boolean;
  /** Access token lifetime in seconds (default 3600). */
  accessTtl?: number;
  /** Publish protected-resource metadata (default true). */
  resourceMetadata?: boolean;
  /** Issue a new refresh token on every refresh (default true). */
  rotateRefresh?: boolean;
}

export interface FakeAuthServer {
  base: string;
  mcpUrl: string;
  registrations: Record<string, unknown>[];
  tokenRequests: Record<string, string>[];
  revoked: string[];
  /** Bearer tokens seen on /mcp, in order. */
  bearers: string[];
  /** Follow the authorization URL as a signed-in user would; returns the redirect target. */
  authorize(url: string, opts?: { deny?: boolean }): Promise<URL>;
  /** Make an issued access token expire now. */
  expire(token: string): void;
  /** The access tokens issued so far. */
  accessTokens(): string[];
  close(): Promise<void>;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string | null;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function startFakeAuthServer(opts: FakeAuthOptions = {}): Promise<FakeAuthServer> {
  const o = {
    dcr: true,
    cimd: false,
    s256: true,
    accessTtl: 3600,
    resourceMetadata: true,
    rotateRefresh: true,
    ...opts,
  };
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, Code>();
  const access = new Map<string, number>();
  const refresh = new Map<string, { clientId: string; scope: string }>();
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const revoked: string[] = [];
  const bearers: string[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let base = '';

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const issue = (clientId: string, scope: string) => {
    const at = `at-${b64url(randomBytes(12))}`;
    access.set(at, Date.now() + o.accessTtl * 1000);
    const rt = `rt-${b64url(randomBytes(12))}`;
    refresh.set(rt, { clientId, scope });
    return {
      access_token: at,
      token_type: 'Bearer',
      expires_in: o.accessTtl,
      refresh_token: rt,
      scope,
    };
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      if (!o.resourceMetadata) return json(res, 404, { error: 'not_found' });
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read', 'write'],
      });
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        ...(o.dcr ? { registration_endpoint: `${base}/register` } : {}),
        ...(o.cimd ? { client_id_metadata_document_supported: true } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(o.s256 ? { code_challenge_methods_supported: ['S256'] } : {}),
      });
    }
    if (req.method === 'POST' && path === '/register' && o.dcr) {
      const body = JSON.parse(await read(req)) as { redirect_uris?: string[] };
      registrations.push(body);
      const id = `dyn-${registrations.length}`;
      clients.set(id, { redirectUris: body.redirect_uris ?? [] });
      return json(res, 201, {
        ...body,
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      });
    }
    if (req.method === 'GET' && path === '/authorize') {
      const q = url.searchParams;
      const clientId = q.get('client_id') ?? '';
      const redirectUri = q.get('redirect_uri') ?? '';
      const known = clients.get(clientId);
      const cimdOk = o.cimd && clientId.startsWith('https://');
      if ((!known && !cimdOk) || (known && !known.redirectUris.includes(redirectUri)))
        return json(res, 400, { error: 'invalid_client' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge'))
        return json(res, 400, { error: 'invalid_request' });
      const target = new URL(redirectUri);
      if (q.get('deny') === '1') {
        target.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${b64url(randomBytes(9))}`;
        codes.set(code, {
          clientId,
          redirectUri,
          challenge: q.get('code_challenge')!,
          scope: q.get('scope') ?? '',
          resource: q.get('resource'),
        });
        target.searchParams.set('code', code);
      }
      target.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/token') {
      const form = Object.fromEntries(new URLSearchParams(await read(req)));
      tokenRequests.push(form);
      if (form.grant_type === 'authorization_code') {
        const c = codes.get(form.code ?? '');
        codes.delete(form.code ?? '');
        const verifier = form.code_verifier ?? '';
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        if (
          !c ||
          c.clientId !== form.client_id ||
          c.redirectUri !== form.redirect_uri ||
          c.challenge !== challenge
        )
          return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(c.clientId, c.scope));
      }
      if (form.grant_type === 'refresh_token') {
        const r = refresh.get(form.refresh_token ?? '');
        if (!r || revoked.includes(form.refresh_token ?? ''))
          return json(res, 400, { error: 'invalid_grant' });
        const t = issue(r.clientId, r.scope);
        if (o.rotateRefresh) refresh.delete(form.refresh_token!);
        else {
          refresh.delete(t.refresh_token);
          t.refresh_token = form.refresh_token!;
        }
        return json(res, 200, o.rotateRefresh ? t : { ...t, refresh_token: undefined });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && path === '/revoke') {
      const form = Object.fromEntries(new URLSearchParams(await read(req)));
      if (form.token) {
        revoked.push(form.token);
        access.delete(form.token);
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (path === '/mcp') {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token) bearers.push(token);
      const exp = access.get(token);
      if (!exp || exp <= Date.now()) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      return serveMcp(req, res);
    }
    json(res, 404, { error: 'not_found' });
  }

  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = req.method === 'POST' ? await read(req) : undefined;
    const sid = headers.get('mcp-session-id');
    let t = sid ? sessions.get(sid) : undefined;
    if (!t) {
      if (sid) {
        res.writeHead(404);
        res.end();
        return;
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, transport),
      });
      await createTestServer({ log: () => undefined }).connect(transport);
      t = transport;
    }
    const response = await t.handleRequest(
      new Request(`${base}/mcp`, {
        method: req.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      res.on('close', () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    base,
    mcpUrl: `${base}/mcp`,
    registrations,
    tokenRequests,
    revoked,
    bearers,
    authorize: async (url, a = {}) => {
      const u = new URL(url);
      if (a.deny) u.searchParams.set('deny', '1');
      const res = await fetch(u, { redirect: 'manual' });
      const loc = res.headers.get('location');
      if (res.status !== 302 || !loc)
        throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
      return new URL(loc);
    },
    expire: (token) => {
      if (access.has(token)) access.set(token, Date.now() - 1);
    },
    accessTokens: () => [...access.keys()],
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
