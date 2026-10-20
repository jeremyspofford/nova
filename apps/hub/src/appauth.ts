// Third-party app authorization (FR-222, ADR-097 D6), the Hub area. OAuth 2.0 authorization code
// with PKCE (S256 only) for native public clients:
//   POST /api/v1/apps/register          public, rate-limited per address (RFC 7591)
//   GET  /api/v1/apps/authorize?<query> the consent page's details (owner session)
//   POST /api/v1/apps/authorize         the owner's decision -> {redirectTo} (owner session)
//   POST /api/v1/oauth/token            public: code + verifier, or refresh (RFC 6749, 7636)
//   POST /api/v1/oauth/revoke           public: the token itself (RFC 7009)
//   GET  /api/v1/apps, DELETE /api/v1/apps/:id   the owner's list and revoke
//   GET  /.well-known/oauth-authorization-server  public metadata (RFC 8414)
// The consent page itself is the web app's `/authorize`. An approval is an app authorization of
// kind `app`, so GET/DELETE /api/v1/app-authorizations list and revoke apps too.
//
// App tokens (`nva_`) authenticate through AuthService once this area's route gate is installed:
// the gate admits an app token only to the app-scoped routes (APP_ROUTE_SCOPES) its scopes name,
// only as `Authorization: Bearer`, and audits the calls (one `app.calls` entry per app per hour,
// each refusal on its own). Everything else, owner
// administration included, is refused (403 `policy_denied`). Managed policy (`managed.restrict`,
// D4 `restrict.apps`, checked first so the refusal says `{reason: managed}`) and `apps.enabled`
// can turn all of it off; tokens stop at once.
import { hostname } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APP_SCOPES,
  NovaError,
  appAuthorizeDecisionSchema,
  appRegisterSchema,
  idSchema,
  oauthRevokeRequestSchema,
  oauthTokenRequestSchema,
  type AppAuthorizeResultView,
} from '@nova/shared';
import {
  AppAuthService,
  OAuthError,
  SlidingWindowLimiter,
  appRouteScope,
  isHubOwner,
  managedRestrictions,
  ownerOnlyError,
  type AppTokenIdentity,
  type AppsAllowed,
  type AuditSink,
} from '@nova/core';
import type { AuthService } from './auth.ts';
import type { HubConfig } from './config.ts';
import type { HubArea, HubContext } from './hub-context.ts';

export interface AppAuthArea extends HubArea {
  service: AppAuthService;
  useAudit(audit: AuditSink): void;
}

interface Limit {
  limit: number;
  windowMs: number;
}

export interface AppAuthDeps {
  /** Where `nva_` tokens are resolved; the area hands it its verifier when it registers its gate. */
  auth: Pick<AuthService, 'useAppTokens'>;
  audit?: AuditSink;
  /** Tests: a clock, lower limits, a faster sweep. */
  now?: () => Date;
  limits?: { register?: Limit; token?: Limit; revoke?: Limit };
  sweepIntervalMs?: number;
  maxPendingClients?: number;
}

/** A form body that repeated a parameter (RFC 6749 §3.2: parameters are sent once). */
const REPEATED = '__repeated';

// ---- the Hub's own addresses ---------------------------------------------------------------
// A code must never be delivered to the Hub itself: one of its own callbacks could forward it to
// a token endpoint someone else configured (the email and MCP OAuth callbacks post the code they
// receive). The apps area refuses such redirect URIs, and those callbacks refuse a code whose
// `iss` names this Hub.

const LOOPBACK_NAME = /^(localhost|\[::1\]|::1|127(\.\d{1,3}){3}|0\.0\.0\.0)$/i;

/**
 * The ports this Hub answers on: its configured port and fallbacks, what it listens on, and the
 * port of each `host` given (how a request reached it).
 */
export function hubPorts(
  config: Pick<HubConfig, 'port' | 'portFallbacks'>,
  app: Pick<FastifyInstance, 'addresses'> | null,
  hosts: (string | null | undefined)[] = [],
): Set<number> {
  const out = new Set<number>();
  if (config.port > 0)
    for (let i = 0; i <= Math.max(0, config.portFallbacks); i++) out.add(config.port + i);
  try {
    for (const a of app?.addresses() ?? []) if (a.port) out.add(a.port);
  } catch {
    // not listening yet
  }
  for (const h of hosts) {
    const port = h ? portOf(`http://${h}`) : null;
    if (port) out.add(port);
  }
  return out;
}

function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
}

/**
 * Whether a URL names this Hub: the host a request reached it by, one of its configured origins,
 * or a loopback (or its own) name on one of its ports. Fails closed on what does not parse.
 */
export function isHubUrl(
  url: string,
  hub: {
    config: Pick<HubConfig, 'port' | 'portFallbacks' | 'host' | 'allowedOrigins'>;
    app: Pick<FastifyInstance, 'addresses'> | null;
    requestHost?: string | undefined;
  },
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const host = u.host.toLowerCase();
  const reqHost = hub.requestHost?.toLowerCase();
  if (reqHost && (host === reqHost || `${host}:${portOf(url) ?? ''}` === reqHost)) return true;
  for (const o of hub.config.allowedOrigins) {
    try {
      if (new URL(o).origin === u.origin) return true;
    } catch {
      // a malformed configured origin names nothing
    }
  }
  const name = u.hostname.toLowerCase();
  const own =
    LOOPBACK_NAME.test(name) ||
    name === hub.config.host.toLowerCase() ||
    name === hostname().toLowerCase() ||
    name === `${hostname().toLowerCase()}.local`;
  const port = portOf(url);
  return own && port !== null && hubPorts(hub.config, hub.app, [reqHost]).has(port);
}

const params = z.object({ id: idSchema });
const clientParams = z.object({ clientId: idSchema });

export function setupAppAuth(ctx: HubContext, deps: AppAuthDeps): Promise<AppAuthArea> {
  const log = ctx.log.child('apps');
  let audit: AuditSink | null = deps.audit ?? null;

  // Read on every request. Managed policy first: it also locks `apps.enabled` off, and the
  // refusal must name it. A policy that cannot be read fails closed.
  const allowed = async (): Promise<AppsAllowed> => {
    let managedWhy: string | null;
    try {
      managedWhy = managedRestrictions(await ctx.setting('managed.restrict')).apps();
    } catch (err) {
      log.warn('managed app policy unreadable; apps are off', { err });
      managedWhy = 'unreadable';
    }
    if (managedWhy) return { ok: false, reason: 'managed' };
    return (await ctx.setting('apps.enabled')) === true
      ? { ok: true }
      : { ok: false, reason: 'disabled' };
  };

  // The Fastify instance, once registered: its listening ports are the Hub's own.
  let appRef: FastifyInstance | null = null;

  const service = new AppAuthService({
    db: ctx.db,
    events: ctx.events,
    allowed,
    // A loopback redirect on one of the Hub's own ports would hand the code to the Hub itself.
    reservedRedirect: (uri, issuer) => {
      const port = uri.port ? Number(uri.port) : 80;
      const issuerHost = issuer ? new URL(issuer).host : null;
      return hubPorts(ctx.config, appRef, [issuerHost]).has(port);
    },
    // Late-bound: the ops area's audit sink may arrive after setup.
    audit: { append: (r) => (audit ? audit.append(r) : Promise.resolve()) },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.maxPendingClients ? { maxPendingClients: deps.maxPendingClients } : {}),
  });

  const limiter = (l: Limit | undefined, d: Limit) =>
    new SlidingWindowLimiter({
      limit: l?.limit ?? d.limit,
      windowMs: l?.windowMs ?? d.windowMs,
      ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
    });
  const registerLimiter = limiter(deps.limits?.register, { limit: 10, windowMs: 3_600_000 });
  const tokenLimiter = limiter(deps.limits?.token, { limit: 60, windowMs: 60_000 });
  const revokeLimiter = limiter(deps.limits?.revoke, { limit: 60, windowMs: 60_000 });

  const sweep = setInterval(() => {
    service
      .sweep()
      .then((n) => {
        if (n.codes || n.tokens || n.clients) log.debug('app authorization sweep', n);
      })
      .catch((err: unknown) => log.warn('app authorization sweep failed', { err }));
  }, deps.sweepIntervalMs ?? 3_600_000);
  sweep.unref();
  // The hourly call summaries are written once their hour is over.
  const callFlush = setInterval(() => {
    service
      .flushCalls()
      .catch((err: unknown) => log.warn('app call summaries not audited', { err }));
  }, 60_000);
  callFlush.unref();

  ctx.diagnostics.add('apps', async () => ({
    enabled: (await allowed()).ok,
    ...service.counts(),
  }));

  /** The issuer: this Hub as the request reached it (Host is checked by the Hub's guard). */
  const issuerOf = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? '127.0.0.1'}`;

  /** The raw query string of the request (the app's authorization request, passed through). */
  const queryOf = (req: FastifyRequest) => {
    const i = req.url.indexOf('?');
    return i < 0 ? '' : req.url.slice(i + 1);
  };

  async function owner(req: FastifyRequest): Promise<string> {
    const accountId = await ctx.accountOf(req);
    // Members do not authorize apps in M8 (like MCP clients, the Hub's integrations are the
    // owner's); refused here whatever the route classification says.
    if (!isHubOwner(ctx.db, accountId)) throw ownerOnlyError("the Hub's app authorizations");
    return accountId;
  }

  function limited(l: SlidingWindowLimiter, req: FastifyRequest): void {
    if (!l.take(req.ip))
      throw new NovaError('rate_limited', 'too many requests from this address', {
        details: { reason: 'address_rate_limited' },
      });
  }

  /** Answer a token-endpoint error in RFC 6749 §5.2 form; anything else goes to the Hub's handler. */
  function oauthReply(reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof OAuthError) return reply.status(err.status).send(err.toJSON());
    if (err instanceof NovaError && err.code === 'rate_limited')
      return reply
        .status(429)
        .send(new OAuthError('slow_down', 'too many requests from this address', 429).toJSON());
    throw err;
  }

  /** Requests an app token got through the gate, for the `app.call` audit when they finish. */
  const admitted = new WeakMap<FastifyRequest, AppTokenIdentity>();

  function register(app: FastifyInstance): void {
    appRef = app;
    // ---- the app-token gate: before any other hook or handler sees the request ---------------
    app.addHook('onRequest', async (req, reply) => {
      const p = req.principal;
      if (!p?.app || !p.accountId) return;
      const route = req.routeOptions.url;
      const scope = appRouteScope(req.method, route);
      if (scope === 'public') return;
      // App tokens are bearer tokens only (RFC 6750 §2.1): one in the session cookie is nothing.
      if (!/^Bearer nva_/.test(req.headers.authorization ?? ''))
        throw new NovaError('token_required', 'sign in to use the Hub');
      const id: AppTokenIdentity = {
        tokenId: p.tokenId,
        accountId: p.accountId,
        authorizationId: p.app.authorizationId,
        clientId: p.app.clientId,
        clientName: p.app.clientName,
        scopes: p.app.scopes as AppTokenIdentity['scopes'],
      };
      const routeName = route ?? req.url.split('?')[0] ?? '';
      if (scope && id.scopes.includes(scope)) {
        admitted.set(req, id);
        return;
      }
      await service.auditCall(id, {
        method: req.method,
        route: routeName,
        status: 403,
        decision: 'deny',
      });
      if (scope) {
        void reply.header(
          'WWW-Authenticate',
          `Bearer realm="nova", error="insufficient_scope", scope="${scope}"`,
        );
        throw new NovaError('policy_denied', `this app was not granted ${scope}`, {
          details: { reason: 'insufficient_scope', scope },
        });
      }
      throw new NovaError('policy_denied', 'apps cannot use this part of the Hub', {
        details: { reason: 'not_app_scoped' },
      });
    });
    app.addHook('onResponse', (req, reply, done) => {
      // Counted, and written as one `app.calls` entry per app per hour (refusals: one each).
      const id = admitted.get(req);
      if (id)
        service.noteCall(id, {
          method: req.method,
          route: req.routeOptions.url ?? '',
          status: reply.statusCode,
        });
      done();
    });

    // ---- public: registration, tokens, revocation, metadata -----------------------------------
    // Open registration (`apps.openRegistration`, on by default) is public and limited per
    // address; the owner's session registers past the limit and the pending cap, and is the only
    // way while open registration is off.
    app.post('/api/v1/apps/register', async (req, reply) => {
      const byOwner =
        !!req.principal?.accountId &&
        !req.principal.app &&
        isHubOwner(ctx.db, req.principal.accountId);
      if (!byOwner) {
        if (!(await ctx.setting('apps.openRegistration')))
          throw new NovaError('policy_denied', 'apps cannot register themselves on this Hub', {
            details: { reason: 'registration_closed' },
            action: 'Ask the owner to register the app',
          });
        limited(registerLimiter, req);
      }
      const body = appRegisterSchema.parse(req.body);
      const out = await service.register(body, { byOwner });
      log.info('app registered', { clientId: out.client_id, byOwner });
      void reply.header('cache-control', 'no-store').status(201);
      return out;
    });

    app.get('/.well-known/oauth-authorization-server', (req) => {
      const issuer = issuerOf(req);
      return {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/api/v1/oauth/token`,
        registration_endpoint: `${issuer}/api/v1/apps/register`,
        revocation_endpoint: `${issuer}/api/v1/oauth/revoke`,
        scopes_supported: [...APP_SCOPES],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      };
    });

    void app.register((scoped, _opts, done) => {
      // OAuth clients send form bodies (RFC 6749 §4.1.3); JSON is accepted too.
      scoped.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 16 * 1024 },
        (
          _req: FastifyRequest,
          body: string | Buffer,
          next: (e: Error | null, b?: unknown) => void,
        ) => {
          const out: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(body.toString())) {
            if (Object.hasOwn(out, k)) out[REPEATED] = k;
            else out[k] = v;
          }
          next(null, out);
        },
      );

      scoped.post('/api/v1/oauth/token', async (req, reply) => {
        void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
        try {
          limited(tokenLimiter, req);
          const body = bodyOf(req.body);
          const grant = body.grant_type;
          if (grant !== 'authorization_code' && grant !== 'refresh_token')
            throw new OAuthError(
              grant === undefined ? 'invalid_request' : 'unsupported_grant_type',
              grant === undefined ? 'grant_type is required' : 'unsupported grant_type',
            );
          const parsed = oauthTokenRequestSchema.safeParse(body);
          if (!parsed.success)
            throw new OAuthError(
              'invalid_request',
              `missing or malformed ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
            );
          const r = parsed.data;
          return r.grant_type === 'authorization_code'
            ? await service.exchangeCode({
                code: r.code,
                redirectUri: r.redirect_uri,
                clientId: r.client_id,
                codeVerifier: r.code_verifier,
              })
            : await service.refresh({
                refreshToken: r.refresh_token,
                clientId: r.client_id,
                ...(r.scope !== undefined ? { scope: r.scope } : {}),
              });
        } catch (err) {
          return oauthReply(reply, err);
        }
      });

      scoped.post('/api/v1/oauth/revoke', async (req, reply) => {
        void reply.header('cache-control', 'no-store');
        try {
          limited(revokeLimiter, req);
          const parsed = oauthRevokeRequestSchema.safeParse(bodyOf(req.body));
          if (!parsed.success)
            throw new OAuthError('invalid_request', 'token and client_id are required');
          await service.revokeToken({ token: parsed.data.token, clientId: parsed.data.client_id });
          return reply.status(200).send({});
        } catch (err) {
          return oauthReply(reply, err);
        }
      });
      done();
    });

    // ---- the consent (owner session) ---------------------------------------------------------
    app.get('/api/v1/apps/authorize', async (req) => {
      const accountId = await owner(req);
      return service.consent(accountId, queryOf(req), issuerOf(req));
    });

    app.post('/api/v1/apps/authorize', async (req, reply) => {
      const accountId = await owner(req);
      const body = appAuthorizeDecisionSchema.parse(req.body);
      const out = await service.decide(accountId, body, issuerOf(req));
      // The answer carries a one-use code: never cached.
      void reply.header('cache-control', 'no-store');
      const view: AppAuthorizeResultView = { redirectTo: out.redirectTo };
      return view;
    });

    // ---- the owner's list -------------------------------------------------------------------
    app.get('/api/v1/apps', async (req) => ({ items: service.listGrants(await owner(req)) }));

    // Registered apps no one authorizes, and deleting one (M8 web: the Apps settings page).
    app.get('/api/v1/apps/pending', async (req) => {
      await owner(req);
      return { items: service.listPending() };
    });

    app.delete('/api/v1/apps/pending/:clientId', async (req) => {
      const accountId = await owner(req);
      const { clientId } = clientParams.parse(req.params);
      await service.deletePending(accountId, clientId);
      return { ok: true };
    });

    app.delete('/api/v1/apps/:id', async (req) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      await service.revokeGrant(accountId, id);
      return { ok: true };
    });

    // App tokens authenticate only now that the gate above stands in front of every route.
    deps.auth.useAppTokens(async (token) => {
      const id = await service.verifyAccess(token);
      if (!id) return null;
      return {
        tokenId: id.tokenId,
        accountId: id.accountId,
        app: {
          clientId: id.clientId,
          clientName: id.clientName,
          authorizationId: id.authorizationId,
          scopes: id.scopes,
        },
      };
    });
  }

  return Promise.resolve({
    service,
    register,
    useAudit: (a) => {
      audit = a;
    },
    close: async () => {
      clearInterval(sweep);
      clearInterval(callFlush);
      await service.flushCalls(true).catch((err: unknown) => {
        log.warn('app call summaries not audited', { err });
        return 0;
      });
    },
  });
}

/** A token or revoke body as a plain record; a repeated parameter is `invalid_request`. */
function bodyOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new OAuthError('invalid_request', 'the body must be form-encoded or JSON');
  const b = body as Record<string, unknown>;
  if (typeof b[REPEATED] === 'string')
    throw new OAuthError('invalid_request', `${b[REPEATED]} is repeated`);
  return b;
}
