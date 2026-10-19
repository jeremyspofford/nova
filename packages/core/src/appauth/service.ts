// Third-party app authorization (FR-222, ADR-097 D6): OAuth 2.0 authorization code with PKCE (S256
// only) for public clients. Apps register themselves (public, rate-limited by the Hub area); the
// owner approves on the consent page, which makes an app authorization of kind `app` (the M4
// table Settings lists and revokes, FR-192) and a one-use code; the app trades the code and its
// verifier for an access token (`nva_`, 1 hour) and a refresh token (`nva_`, 30 days). Every
// refresh rotates the refresh token; presenting a used one again (or a used code) revokes the
// whole chain. Codes and tokens are stored only as SHA-256 hashes. Every step is audited.
import { randomBytes } from 'node:crypto';
import {
  APP_ACCESS_TOKEN_TTL_S,
  APP_CODE_TTL_S,
  APP_REFRESH_TOKEN_TTL_S,
  APP_SCOPE_TEXT,
  NovaError,
  uuidv7,
  type AppAuthorizeDecision,
  type AppClientRegisteredView,
  type AppConsentView,
  type AppGrantView,
  type AppPendingView,
  type AppRegisterRequest,
  type AppScope,
  type OAuthTokenError,
  type OAuthTokenResponse,
} from '@nova/shared';
import { hashToken, newToken } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { EventSink } from '../events.ts';
import { hubOwnerId } from '../team/owner.ts';
import type { AuditRecord, AuditSink } from '../tools/types.ts';
import { isCodeVerifier, isS256Challenge, verifyPkce } from './pkce.ts';
import { checkRedirectUri, matchRedirectUri, redirectWith, type RedirectKind } from './redirect.ts';
import {
  formatScopes,
  grantScopesJson,
  parseScopeParam,
  readGrantScopes,
  readScopeList,
  sortScopes,
} from './scopes.ts';

/** Whether apps may be authorized now: the `apps.enabled` setting and managed policy (D4). */
export type AppsAllowed = { ok: true } | { ok: false; reason: 'disabled' | 'managed' };

export interface AppAuthServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  /** Read on every call, so turning apps off stops every token at once. */
  allowed: () => Promise<AppsAllowed>;
  audit?: AuditSink;
  now?: () => Date;
  /** Clients nobody approved yet, Hub-wide (default 100): registration refuses beyond it. */
  maxPendingClients?: number;
  /**
   * How long a registration nobody approved stays (default 1 hour): after it, the client is
   * unknown and its place under the cap is free, so a flood of registrations ages out quickly.
   */
  pendingTtlMs?: number;
  /**
   * Whether a loopback redirect URI points at the Hub itself (one of its own ports). `issuer` is
   * the Hub as the consent request reached it, null at registration. The Hub area provides it.
   */
  reservedRedirect?: (uri: URL, issuer: string | null) => boolean;
}

/** What an access token stands for (the Hub's principal for an app). */
export interface AppTokenIdentity {
  tokenId: string;
  accountId: string;
  authorizationId: string;
  clientId: string;
  clientName: string;
  /** The token's scopes still granted by its authorization. */
  scopes: AppScope[];
}

/** A token endpoint refusal in RFC 6749 §5.2 form. */
export class OAuthError extends Error {
  readonly error: OAuthTokenError;
  readonly status: number;
  constructor(error: OAuthTokenError, description: string, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }
  toJSON(): { error: OAuthTokenError; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}

/** A checked authorization request (the consent page's query). */
export interface AuthorizationRequest {
  client: ClientRow;
  redirectUri: string;
  redirectKind: RedirectKind;
  scopes: AppScope[];
  state: string | undefined;
  codeChallenge: string;
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  scopes: string;
  created_at: string;
  approved_at: string | null;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  account_id: string;
  authorization_id: string;
  redirect_uri: string;
  scopes: string;
  code_challenge: string;
  expires_at: string;
  used_at: string | null;
  family_id: string | null;
}

interface TokenRow {
  id: string;
  kind: 'access' | 'refresh';
  family_id: string;
  authorization_id: string;
  client_id: string;
  account_id: string;
  scopes: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

interface AuthorizationRow {
  id: string;
  account_id: string;
  kind: string;
  client_name: string;
  scopes: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
}

/** OAuth's authorization-request parameters; each may appear once (RFC 6749 §3.1). */
const REQUEST_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

/** `last_used_at` is written at most this often per authorization (as for MCP clients). */
const TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;
/** Routes listed per hourly summary; calls to further routes are counted in `calls` only. */
const MAX_CALL_ROUTES = 50;

export class AppAuthService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #allowed: () => Promise<AppsAllowed>;
  readonly #now: () => Date;
  readonly #maxPending: number;
  readonly #pendingTtlMs: number;
  readonly #reserved: (uri: URL, issuer: string | null) => boolean;
  readonly #touched = new Map<string, number>();
  /** Allowed calls by app and hour, until `flushCalls` writes them. */
  readonly #calls = new Map<
    string,
    {
      id: Pick<AppTokenIdentity, 'accountId' | 'authorizationId' | 'clientId' | 'clientName'>;
      hour: string;
      calls: number;
      errors: number;
      routes: Map<string, number>;
    }
  >();
  #audit: AuditSink | null;

  constructor(o: AppAuthServiceOptions) {
    this.#db = o.db;
    this.#events = o.events;
    this.#allowed = o.allowed;
    this.#audit = o.audit ?? null;
    this.#now = o.now ?? (() => new Date());
    this.#maxPending = o.maxPendingClients ?? 100;
    this.#pendingTtlMs = o.pendingTtlMs ?? 3_600_000;
    this.#reserved = o.reservedRedirect ?? (() => false);
  }

  setAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  // ---- registration (RFC 7591) --------------------------------------------------------------

  /**
   * Register an app. `byOwner`: the owner registered it with their session (open registration off,
   * or the cap reached): it is not counted under the cap and does not expire unapproved.
   */
  async register(
    req: AppRegisterRequest,
    opts: { byOwner?: boolean } = {},
  ): Promise<AppClientRegisteredView> {
    await this.#mustBeAllowed();
    for (const uri of req.redirectUris) {
      const c = checkRedirectUri(uri);
      const reason = !c.ok
        ? c.reason
        : c.kind === 'loopback' && this.#reserved(new URL(uri), null)
          ? 'hub_address'
          : null;
      if (reason)
        throw new NovaError('validation', `redirect URI ${uri} is not allowed`, {
          details: { field: 'redirectUris', reason },
        });
    }
    const now = this.#now();
    const id = uuidv7();
    const scopes = sortScopes(req.scopes);
    const redirectUris = [...new Set(req.redirectUris)];
    await this.#db.transaction(() => {
      // Registrations nobody approved in time go first, so the cap counts only live ones.
      this.#dropExpiredPending(now.getTime());
      const pending = this.#db.raw
        .prepare('SELECT COUNT(*) AS n FROM app_client WHERE approved_at IS NULL')
        .get() as { n: number };
      if (!opts.byOwner && pending.n >= this.#maxPending)
        throw new NovaError('rate_limited', 'too many apps are waiting for approval', {
          details: { reason: 'too_many_pending_apps' },
        });
      this.#db.raw
        .prepare(
          `INSERT INTO app_client (id, name, redirect_uris, scopes, created_at, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          req.name,
          JSON.stringify(redirectUris),
          JSON.stringify(scopes),
          now.toISOString(),
          opts.byOwner ? now.toISOString() : null,
        );
    });
    // Registration has no account; the Hub owner's log records it.
    const owner = hubOwnerId(this.#db);
    if (owner)
      await this.#log({
        accountId: owner,
        actor: `app_client:${id}`,
        kind: 'auth',
        action: 'app.client.register',
        resource: `app_client:${id}`,
        detail: { clientId: id, name: req.name, redirectUris, scopes, byOwner: !!opts.byOwner },
      });
    return {
      client_id: id,
      client_name: req.name,
      redirect_uris: redirectUris,
      scope: formatScopes(scopes),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(now.getTime() / 1000),
    };
  }

  // ---- the authorization request and the consent --------------------------------------------

  /**
   * Check an authorization request (the `/authorize` query). An unknown client or a redirect URI
   * that does not match is `not_found` / `validation` with no `redirectTo`: the browser must never
   * be sent to an unverified URI (RFC 6749 §4.1.2.1). Every other problem carries `redirectTo`,
   * the app's redirect with the OAuth error.
   */
  async parseRequest(query: string, issuer: string): Promise<AuthorizationRequest> {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    const one = (k: (typeof REQUEST_PARAMS)[number]) => params.get(k) ?? undefined;
    const twice = REQUEST_PARAMS.filter((k) => params.getAll(k).length > 1);
    if (twice.includes('client_id') || twice.includes('redirect_uri'))
      throw new NovaError('validation', 'the request repeats client_id or redirect_uri', {
        details: { reason: 'invalid_request' },
      });
    const clientId = one('client_id');
    const client = clientId ? this.#liveClient(clientId) : null;
    if (!client)
      throw new NovaError('not_found', 'this app is not registered with the Hub', {
        details: { reason: 'unknown_client' },
      });
    const requested = one('redirect_uri');
    if (!requested)
      throw new NovaError('validation', 'the request names no redirect URI', {
        details: { reason: 'redirect_uri_required' },
      });
    // Never the Hub itself (one of its own routes or ports), whatever the app registered.
    const kind = checkRedirectUri(requested);
    if (
      (!kind.ok && kind.reason === 'hub_path') ||
      (kind.ok && kind.kind === 'loopback' && this.#reserved(new URL(requested), issuer))
    )
      throw new NovaError('validation', 'the redirect URI points at this Hub itself', {
        details: { reason: 'redirect_uri_reserved' },
      });
    const registered = readJsonArray(client.redirect_uris);
    const matched = matchRedirectUri(registered, requested);
    if (!matched || !kind.ok)
      throw new NovaError('validation', 'the redirect URI is not one this app registered', {
        details: { reason: 'redirect_uri_mismatch' },
      });
    const state = one('state');
    // From here the redirect URI is verified: errors go back to the app.
    const fail = (
      error: string,
      description: string,
      code: 'validation' | 'policy_denied',
      reason: string = error,
    ) =>
      new NovaError(code, description, {
        details: {
          reason,
          redirectTo: redirectWith(requested, {
            error,
            error_description: description,
            state: state && state.length <= 500 ? state : undefined,
            iss: issuer,
          }),
        },
      });
    const allowed = await this.#allowed();
    if (!allowed.ok)
      throw fail(
        'access_denied',
        allowed.reason === 'managed'
          ? 'your organization turned app authorization off'
          : 'app authorization is turned off on this Hub',
        'policy_denied',
        // Like every other refusal: managed policy is named as such (D4).
        allowed.reason === 'managed' ? 'managed' : 'apps_disabled',
      );
    if (twice.length) throw fail('invalid_request', `repeated ${twice.join(', ')}`, 'validation');
    if (one('response_type') !== 'code')
      throw fail('unsupported_response_type', 'only response_type=code is supported', 'validation');
    if (one('code_challenge_method') !== 'S256')
      throw fail(
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required',
        'validation',
      );
    const codeChallenge = one('code_challenge') ?? '';
    if (!isS256Challenge(codeChallenge))
      throw fail('invalid_request', 'code_challenge is not an S256 challenge', 'validation');
    if (state !== undefined && state.length > 500)
      throw fail('invalid_request', 'state is longer than 500 characters', 'validation');
    const allowedScopes = readScopeList(client.scopes);
    const scopeParam = one('scope');
    let scopes: AppScope[];
    if (scopeParam === undefined) scopes = allowedScopes;
    else {
      const parsed = parseScopeParam(scopeParam);
      if (parsed.unknown.length)
        throw fail('invalid_scope', `unknown scope ${parsed.unknown.join(' ')}`, 'validation');
      scopes = parsed.scopes;
    }
    const extra = scopes.filter((s) => !allowedScopes.includes(s));
    if (extra.length)
      throw fail('invalid_scope', `the app did not register ${extra.join(' ')}`, 'validation');
    if (!scopes.length) throw fail('invalid_scope', 'no scope requested', 'validation');
    return {
      client,
      redirectUri: requested,
      redirectKind: kind.kind,
      scopes,
      state,
      codeChallenge,
    };
  }

  /** What the consent page shows for a request (GET /api/v1/apps/authorize). */
  async consent(accountId: string, query: string, issuer: string): Promise<AppConsentView> {
    const req = await this.parseRequest(query, issuer);
    const grant = this.#activeGrant(accountId, req.client.id);
    const granted = grant ? readGrantScopes(grant.scopes) : [];
    return {
      client: {
        id: req.client.id,
        name: req.client.name,
        redirectUri: req.redirectUri,
        redirectKind: req.redirectKind,
        registeredAt: req.client.created_at,
      },
      scopes: req.scopes.map((scope) => ({
        scope,
        ...APP_SCOPE_TEXT[scope],
        granted: granted.includes(scope),
      })),
      authorized: grant !== null,
    };
  }

  /**
   * The owner's decision. Approve: the app's authorization gets the kept scopes (added to what an
   * earlier approval granted) and the answer is the redirect with a one-use code; deny: the
   * redirect with `access_denied`.
   */
  async decide(
    accountId: string,
    input: AppAuthorizeDecision,
    issuer: string,
  ): Promise<{ redirectTo: string; authorizationId: string | null }> {
    const req = await this.parseRequest(input.query, issuer);
    const back = (params: Record<string, string>) =>
      redirectWith(req.redirectUri, { ...params, state: req.state, iss: issuer });
    if (input.decision === 'deny') {
      await this.#log({
        accountId,
        actor: 'user',
        kind: 'auth',
        action: 'app.authorize.deny',
        resource: `app_client:${req.client.id}`,
        decision: 'deny',
        detail: { clientId: req.client.id, clientName: req.client.name, scopes: req.scopes },
      });
      return {
        redirectTo: back({ error: 'access_denied', error_description: 'the owner said no' }),
        authorizationId: null,
      };
    }
    const kept = input.scopes ? sortScopes(input.scopes) : req.scopes;
    const extra = kept.filter((s) => !req.scopes.includes(s));
    if (extra.length)
      throw new NovaError('validation', `the app did not ask for ${extra.join(' ')}`, {
        details: { field: 'scopes', reason: 'not_requested' },
      });
    const code = randomBytes(32).toString('base64url');
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const out = await this.#db.transaction(() => {
      const existing = this.#activeGrant(accountId, req.client.id);
      let authorizationId: string;
      let added: AppScope[];
      if (existing) {
        authorizationId = existing.id;
        const before = readGrantScopes(existing.scopes);
        added = kept.filter((s) => !before.includes(s));
        this.#db.raw
          .prepare('UPDATE app_authorization SET scopes = ?, client_name = ? WHERE id = ?')
          .run(grantScopesJson([...before, ...kept]), req.client.name, existing.id);
        this.#db.raw
          .prepare('UPDATE app_consent SET updated_at = ? WHERE authorization_id = ?')
          .run(now, existing.id);
      } else {
        authorizationId = uuidv7();
        added = kept;
        // The M4 table wants a token hash on an active row; an app's tokens live in app_token,
        // so this is the hash of a random value that is never issued.
        this.#db.raw
          .prepare(
            `INSERT INTO app_authorization (id, account_id, kind, client_name, scopes, token_hash,
               status, created_at, last_used_at, expires_at, revoked_at)
             VALUES (?, ?, 'app', ?, ?, ?, 'active', ?, NULL, NULL, NULL)`,
          )
          .run(
            authorizationId,
            accountId,
            req.client.name,
            grantScopesJson(kept),
            hashToken(newToken('app')),
            now,
          );
        this.#db.raw
          .prepare(
            `INSERT INTO app_consent (authorization_id, account_id, client_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(authorizationId, accountId, req.client.id, now, now);
      }
      this.#db.raw
        .prepare('UPDATE app_client SET approved_at = ? WHERE id = ? AND approved_at IS NULL')
        .run(now, req.client.id);
      this.#db.raw
        .prepare(
          `INSERT INTO app_code (code_hash, client_id, account_id, authorization_id, redirect_uri,
             scopes, code_challenge, created_at, expires_at, used_at, family_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          hashToken(code),
          req.client.id,
          accountId,
          authorizationId,
          req.redirectUri,
          JSON.stringify(kept),
          req.codeChallenge,
          now,
          new Date(nowDate.getTime() + APP_CODE_TTL_S * 1000).toISOString(),
        );
      return { authorizationId, created: !existing, added };
    });
    if (out.created)
      await this.#events.emit({
        name: 'app.authorization.changed',
        actor: 'user',
        accountId,
        payload: {
          authorizationId: out.authorizationId,
          kind: 'app',
          clientName: req.client.name,
          status: 'active',
        },
      });
    await this.#log({
      accountId,
      actor: 'user',
      kind: 'auth',
      action: out.created ? 'app_authorization.create' : 'app_authorization.update',
      resource: `app_authorization:${out.authorizationId}`,
      decision: 'allow',
      detail: {
        kind: 'app',
        clientId: req.client.id,
        clientName: req.client.name,
        scopes: kept,
        added: out.added,
      },
    });
    return { redirectTo: back({ code }), authorizationId: out.authorizationId };
  }

  // ---- the token endpoint (RFC 6749 §4.1.3, §6; RFC 7636 §4.6) ------------------------------

  async exchangeCode(req: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<OAuthTokenResponse> {
    const client = await this.#tokenClient(req.clientId);
    if (!isCodeVerifier(req.codeVerifier))
      throw new OAuthError('invalid_request', 'code_verifier is malformed');
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const out = await this.#db.transaction(() => {
      const row = this.#db.raw
        .prepare('SELECT * FROM app_code WHERE code_hash = ?')
        .get(hashToken(req.code)) as CodeRow | undefined;
      if (!row || row.client_id !== client.id)
        return { error: 'the code is not valid' as const, reuse: null };
      if (row.used_at) {
        // A code used twice: the chain the first use started is revoked (RFC 6749 §4.1.2).
        const revoked = row.family_id ? this.#revokeFamily(row.family_id, now) : 0;
        return { error: 'the code was already used' as const, reuse: { row, revoked } };
      }
      // A failed attempt burns the code too: the verifier cannot be guessed at.
      this.#db.raw
        .prepare('UPDATE app_code SET used_at = ? WHERE code_hash = ?')
        .run(now, row.code_hash);
      if (row.expires_at <= now) return { error: 'the code expired' as const, reuse: null };
      if (row.redirect_uri !== req.redirectUri)
        return { error: 'redirect_uri differs from the request' as const, reuse: null };
      if (!verifyPkce(req.codeVerifier, row.code_challenge))
        return { error: 'code_verifier does not match' as const, reuse: null };
      const grant = this.#authorization(row.authorization_id);
      if (!grant || grant.status !== 'active')
        return { error: 'the authorization was revoked' as const, reuse: null };
      const scopes = intersect(readScopeList(row.scopes), readGrantScopes(grant.scopes));
      if (!scopes.length) return { error: 'no scope is granted any more' as const, reuse: null };
      const familyId = uuidv7();
      this.#db.raw
        .prepare('UPDATE app_code SET family_id = ? WHERE code_hash = ?')
        .run(familyId, row.code_hash);
      const tokens = this.#issue(row, familyId, scopes, nowDate);
      return { error: null, reuse: null, row, familyId, tokens, scopes };
    });
    if (out.reuse) {
      await this.#log({
        accountId: out.reuse.row.account_id,
        actor: `app_client:${client.id}`,
        kind: 'auth',
        action: 'app.token.reuse',
        resource: `app_authorization:${out.reuse.row.authorization_id}`,
        decision: 'deny',
        detail: {
          clientId: client.id,
          what: 'code',
          familyId: out.reuse.row.family_id,
          tokensRevoked: out.reuse.revoked,
        },
      });
    }
    if (out.error !== null) throw new OAuthError('invalid_grant', out.error);
    await this.#log({
      accountId: out.row.account_id,
      actor: `app_client:${client.id}`,
      kind: 'auth',
      action: 'app.token.issue',
      resource: `app_authorization:${out.row.authorization_id}`,
      decision: 'allow',
      detail: { clientId: client.id, familyId: out.familyId, scopes: out.scopes },
    });
    return out.tokens;
  }

  async refresh(req: {
    refreshToken: string;
    clientId: string;
    scope?: string;
  }): Promise<OAuthTokenResponse> {
    const client = await this.#tokenClient(req.clientId);
    let narrowed: AppScope[] | null = null;
    if (req.scope !== undefined) {
      const parsed = parseScopeParam(req.scope);
      if (parsed.unknown.length || !parsed.scopes.length)
        throw new OAuthError('invalid_scope', 'the scope is not valid');
      narrowed = parsed.scopes;
    }
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const out = await this.#db.transaction(() => {
      const row = this.#token(req.refreshToken, 'refresh');
      if (!row || row.client_id !== client.id)
        return { error: 'the refresh token is not valid' as const, reuse: null };
      if (row.revoked_at) return { error: 'the refresh token was revoked' as const, reuse: null };
      if (row.used_at) {
        // Rotation (D6): a used refresh token presented again means it leaked; end the chain.
        const revoked = this.#revokeFamily(row.family_id, now);
        return { error: 'the refresh token was already used' as const, reuse: { row, revoked } };
      }
      if (row.expires_at <= now)
        return { error: 'the refresh token expired' as const, reuse: null };
      const grant = this.#authorization(row.authorization_id);
      if (!grant || grant.status !== 'active')
        return { error: 'the authorization was revoked' as const, reuse: null };
      const had = readScopeList(row.scopes);
      if (narrowed && narrowed.some((s) => !had.includes(s)))
        return { error: null, scopeError: true as const, reuse: null };
      const scopes = intersect(narrowed ?? had, readGrantScopes(grant.scopes));
      if (!scopes.length) return { error: 'no scope is granted any more' as const, reuse: null };
      this.#db.raw.prepare('UPDATE app_token SET used_at = ? WHERE id = ?').run(now, row.id);
      const tokens = this.#issue(
        {
          client_id: row.client_id,
          account_id: row.account_id,
          authorization_id: row.authorization_id,
        },
        row.family_id,
        scopes,
        nowDate,
      );
      return { error: null, scopeError: false as const, reuse: null, row, tokens, scopes };
    });
    if (out.reuse) {
      await this.#log({
        accountId: out.reuse.row.account_id,
        actor: `app_client:${client.id}`,
        kind: 'auth',
        action: 'app.token.reuse',
        resource: `app_authorization:${out.reuse.row.authorization_id}`,
        decision: 'deny',
        detail: {
          clientId: client.id,
          what: 'refresh_token',
          familyId: out.reuse.row.family_id,
          tokensRevoked: out.reuse.revoked,
        },
      });
    }
    if (out.error !== null) throw new OAuthError('invalid_grant', out.error);
    if (out.scopeError)
      throw new OAuthError('invalid_scope', 'a refresh may only narrow the scopes');
    await this.#log({
      accountId: out.row.account_id,
      actor: `app_client:${client.id}`,
      kind: 'auth',
      action: 'app.token.refresh',
      resource: `app_authorization:${out.row.authorization_id}`,
      decision: 'allow',
      detail: { clientId: client.id, familyId: out.row.family_id, scopes: out.scopes },
    });
    return out.tokens;
  }

  /**
   * RFC 7009 revocation by the app: a refresh token ends its chain, an access token ends itself.
   * An unknown token is answered like a revoked one (§2.2).
   */
  async revokeToken(req: { token: string; clientId: string }): Promise<void> {
    const now = this.#now().toISOString();
    const out = await this.#db.transaction(() => {
      const row = this.#token(req.token, null);
      if (!row) return null;
      if (row.client_id !== req.clientId)
        throw new OAuthError('unauthorized_client', 'the token belongs to another app');
      if (row.kind === 'refresh') return { row, revoked: this.#revokeFamily(row.family_id, now) };
      const res = this.#db.raw
        .prepare('UPDATE app_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now, row.id);
      return { row, revoked: Number(res.changes) };
    });
    if (!out) return;
    await this.#log({
      accountId: out.row.account_id,
      actor: `app_client:${out.row.client_id}`,
      kind: 'auth',
      action: 'app.token.revoke',
      resource: `app_authorization:${out.row.authorization_id}`,
      detail: {
        clientId: out.row.client_id,
        kind: out.row.kind,
        familyId: out.row.family_id,
        tokensRevoked: out.revoked,
      },
    });
  }

  // ---- API calls ---------------------------------------------------------------------------

  /** The identity behind an access token, or null (unknown, expired, revoked, apps off). */
  async verifyAccess(token: string): Promise<AppTokenIdentity | null> {
    if (!token.startsWith('nva_') || token.length > 200) return null;
    if (!(await this.#allowed()).ok) return null;
    const row = this.#token(token, 'access');
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    if (!row || row.revoked_at || row.expires_at <= now) return null;
    const grant = this.#authorization(row.authorization_id);
    if (!grant || grant.status !== 'active' || grant.kind !== 'app') return null;
    const scopes = intersect(readScopeList(row.scopes), readGrantScopes(grant.scopes));
    if (!scopes.length) return null;
    const last = this.#touched.get(grant.id) ?? 0;
    if (nowDate.getTime() - last >= TOUCH_INTERVAL_MS) {
      this.#touched.set(grant.id, nowDate.getTime());
      await this.#db.transaction(() =>
        this.#db.raw
          .prepare('UPDATE app_authorization SET last_used_at = ? WHERE id = ?')
          .run(now, grant.id),
      );
    }
    return {
      tokenId: row.id,
      accountId: row.account_id,
      authorizationId: grant.id,
      clientId: row.client_id,
      clientName: grant.client_name,
      scopes,
    };
  }

  // ---- the owner's list -----------------------------------------------------------------------

  listGrants(accountId: string): AppGrantView[] {
    const now = this.#now().toISOString();
    const rows = this.#db.raw
      .prepare(
        `SELECT a.id, a.scopes, a.created_at, a.last_used_at, c.id AS client_id, c.name,
                c.redirect_uris,
                (SELECT COUNT(DISTINCT t.family_id) FROM app_token t
                  WHERE t.authorization_id = a.id AND t.kind = 'refresh' AND t.revoked_at IS NULL
                    AND t.used_at IS NULL AND t.expires_at > ?) AS sessions
           FROM app_authorization a
           JOIN app_consent k ON k.authorization_id = a.id
           JOIN app_client c ON c.id = k.client_id
          WHERE a.account_id = ? AND a.kind = 'app' AND a.status = 'active'
          ORDER BY a.created_at`,
      )
      .all(now, accountId) as {
      id: string;
      scopes: string;
      created_at: string;
      last_used_at: string | null;
      client_id: string;
      name: string;
      redirect_uris: string;
      sessions: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      name: r.name,
      redirectUris: readJsonArray(r.redirect_uris),
      scopes: readGrantScopes(r.scopes),
      sessions: Number(r.sessions),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /**
   * Registered apps no one authorizes now (GET /api/v1/apps/pending), newest first: those waiting
   * for a first approval (until their registration lapses) and those that do not expire (registered
   * by the owner, or whose authorization was revoked).
   */
  listPending(): AppPendingView[] {
    const now = this.#now().getTime();
    const cutoff = new Date(now - this.#pendingTtlMs).toISOString();
    const rows = this.#db.raw
      .prepare(
        `SELECT c.* FROM app_client c
          WHERE (c.approved_at IS NOT NULL OR c.created_at >= ?)
            AND NOT EXISTS (
              SELECT 1 FROM app_consent k JOIN app_authorization a ON a.id = k.authorization_id
               WHERE k.client_id = c.id AND a.status = 'active')
          ORDER BY c.created_at DESC, c.id DESC`,
      )
      .all(cutoff) as unknown as ClientRow[];
    return rows.map((c) => ({
      clientId: c.id,
      name: c.name,
      redirectHosts: [...new Set(readJsonArray(c.redirect_uris).map(redirectHost))],
      scopes: readScopeList(c.scopes),
      registeredAt: c.created_at,
      expiresAt: c.approved_at
        ? null
        : new Date(Date.parse(c.created_at) + this.#pendingTtlMs).toISOString(),
    }));
  }

  /**
   * Delete a registration no one authorizes (DELETE /api/v1/apps/pending/:clientId). An app that
   * is authorized is `conflict` (revoke it first); its spent codes and tokens and the links of its
   * revoked authorizations go with it (the revoked authorizations stay for the audit trail).
   */
  async deletePending(accountId: string, clientId: string): Promise<void> {
    const client = await this.#db.transaction(() => {
      const c = this.#client(clientId);
      if (!c) throw new NovaError('not_found', 'app not found');
      const active = this.#db.raw
        .prepare(
          `SELECT 1 FROM app_consent k JOIN app_authorization a ON a.id = k.authorization_id
            WHERE k.client_id = ? AND a.status = 'active' LIMIT 1`,
        )
        .get(clientId);
      if (active)
        throw new NovaError('conflict', 'this app is authorized: revoke it first', {
          details: { reason: 'authorized' },
        });
      for (const table of ['app_code', 'app_token', 'app_consent'])
        this.#db.raw.prepare(`DELETE FROM ${table} WHERE client_id = ?`).run(clientId);
      this.#db.raw.prepare('DELETE FROM app_client WHERE id = ?').run(clientId);
      return c;
    });
    await this.#log({
      accountId,
      actor: 'user',
      kind: 'auth',
      action: 'app.client.delete',
      resource: `app_client:${clientId}`,
      detail: { clientId, name: client.name, wasPending: client.approved_at === null },
    });
  }

  /** Revoke an app's authorization and every token it holds (Settings, DELETE /api/v1/apps/:id). */
  async revokeGrant(accountId: string, authorizationId: string): Promise<void> {
    const now = this.#now().toISOString();
    const row = await this.#db.transaction(() => {
      const grant = this.#authorization(authorizationId);
      if (
        !grant ||
        grant.account_id !== accountId ||
        grant.kind !== 'app' ||
        grant.status !== 'active'
      )
        throw new NovaError('not_found', 'app not found');
      this.#db.raw
        .prepare("UPDATE app_authorization SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .run(now, grant.id);
      const res = this.#db.raw
        .prepare(
          'UPDATE app_token SET revoked_at = ? WHERE authorization_id = ? AND revoked_at IS NULL',
        )
        .run(now, grant.id);
      return { grant, revoked: Number(res.changes) };
    });
    await this.#events.emit({
      name: 'app.authorization.changed',
      actor: 'user',
      accountId,
      payload: {
        authorizationId,
        kind: 'app',
        clientName: row.grant.client_name,
        status: 'revoked',
      },
    });
    await this.#log({
      accountId,
      actor: 'user',
      kind: 'auth',
      action: 'app_authorization.revoke',
      resource: `app_authorization:${authorizationId}`,
      detail: {
        kind: 'app',
        clientName: row.grant.client_name,
        scopes: readGrantScopes(row.grant.scopes),
        tokensRevoked: row.revoked,
      },
    });
  }

  /**
   * Count an allowed API call made with an app token. Allowed calls are not audited one by one (an
   * app that polls would grow the audit chain without bound): `flushCalls` writes one `app.calls`
   * entry per app per hour with the count by route. Refused calls are audited at once
   * (`auditCall`).
   */
  noteCall(
    id: Pick<AppTokenIdentity, 'accountId' | 'authorizationId' | 'clientId' | 'clientName'>,
    call: { method: string; route: string; status: number },
  ): void {
    const hour = `${this.#now().toISOString().slice(0, 13)}:00:00.000Z`;
    const key = `${id.authorizationId}|${hour}`;
    let e = this.#calls.get(key);
    if (!e) {
      e = { id, hour, calls: 0, errors: 0, routes: new Map() };
      this.#calls.set(key, e);
    }
    e.calls += 1;
    if (call.status >= 400) e.errors += 1;
    const route = `${call.method} ${call.route}`;
    if (e.routes.has(route) || e.routes.size < MAX_CALL_ROUTES)
      e.routes.set(route, (e.routes.get(route) ?? 0) + 1);
  }

  /** Write the hourly `app.calls` summaries of hours that ended (every one with `all`). */
  async flushCalls(all = false): Promise<number> {
    const current = `${this.#now().toISOString().slice(0, 13)}:00:00.000Z`;
    const due = [...this.#calls.entries()].filter(([, e]) => all || e.hour < current);
    for (const [key] of due) this.#calls.delete(key);
    for (const [, e] of due)
      await this.#log({
        accountId: e.id.accountId,
        actor: `app_client:${e.id.clientId}`,
        kind: 'auth',
        action: 'app.calls',
        resource: `app_authorization:${e.id.authorizationId}`,
        decision: 'allow',
        result: String(e.calls),
        detail: {
          clientId: e.id.clientId,
          clientName: e.id.clientName,
          hour: e.hour,
          calls: e.calls,
          errors: e.errors,
          routes: Object.fromEntries(e.routes),
        },
      });
    return due.length;
  }

  /** Audit one refused API call made with an app token (`app.call`). */
  async auditCall(
    id: Pick<AppTokenIdentity, 'accountId' | 'authorizationId' | 'clientId' | 'clientName'>,
    call: { method: string; route: string; status: number | null; decision: 'allow' | 'deny' },
  ): Promise<void> {
    await this.#log({
      accountId: id.accountId,
      actor: `app_client:${id.clientId}`,
      kind: 'auth',
      action: 'app.call',
      resource: `app_authorization:${id.authorizationId}`,
      decision: call.decision,
      result: call.status === null ? null : String(call.status),
      detail: {
        clientId: id.clientId,
        clientName: id.clientName,
        method: call.method,
        route: call.route,
      },
    });
  }

  // ---- housekeeping ----------------------------------------------------------------------

  /**
   * Remove expired codes and tokens, and registrations nobody approved in time. Refresh tokens
   * stay until they expire, so a reused one is still recognized.
   */
  async sweep(): Promise<{ codes: number; tokens: number; clients: number }> {
    const now = this.#now().getTime();
    const hourAgo = new Date(now - 3_600_000).toISOString();
    const dayAgo = new Date(now - DAY_MS).toISOString();
    return this.#db.transaction(() => {
      const codes = this.#db.raw.prepare('DELETE FROM app_code WHERE expires_at < ?').run(hourAgo);
      const tokens = this.#db.raw.prepare('DELETE FROM app_token WHERE expires_at < ?').run(dayAgo);
      return {
        codes: Number(codes.changes),
        tokens: Number(tokens.changes),
        clients: this.#dropExpiredPending(now),
      };
    });
  }

  /** Delete registrations nobody approved within the pending lifetime (inside a transaction). */
  #dropExpiredPending(nowMs: number): number {
    const res = this.#db.raw
      .prepare(
        `DELETE FROM app_client WHERE approved_at IS NULL AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM app_code c WHERE c.client_id = app_client.id)`,
      )
      .run(new Date(nowMs - this.#pendingTtlMs).toISOString());
    return Number(res.changes);
  }

  /** Diagnostics: counts only. */
  counts(): {
    clients: number;
    pendingClients: number;
    authorizations: number;
    liveTokens: number;
  } {
    const now = this.#now().toISOString();
    const n = (sql: string, ...args: string[]) =>
      Number((this.#db.raw.prepare(sql).get(...args) as { n: number }).n);
    return {
      clients: n('SELECT COUNT(*) AS n FROM app_client'),
      pendingClients: n('SELECT COUNT(*) AS n FROM app_client WHERE approved_at IS NULL'),
      authorizations: n(
        "SELECT COUNT(*) AS n FROM app_authorization WHERE kind = 'app' AND status = 'active'",
      ),
      liveTokens: n(
        'SELECT COUNT(*) AS n FROM app_token WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at > ?',
        now,
      ),
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  async #mustBeAllowed(): Promise<void> {
    const a = await this.#allowed();
    if (!a.ok)
      throw new NovaError(
        'policy_denied',
        a.reason === 'managed'
          ? 'your organization turned app authorization off'
          : 'app authorization is turned off on this Hub',
        { details: { reason: a.reason === 'managed' ? 'managed' : 'apps_disabled' } },
      );
  }

  /** The client of a token request; apps off is `unauthorized_client`. */
  async #tokenClient(clientId: string): Promise<ClientRow> {
    if (!(await this.#allowed()).ok)
      throw new OAuthError('unauthorized_client', 'app authorization is turned off on this Hub');
    const client = this.#client(clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
    return client;
  }

  /** A client that is approved, or registered within the pending lifetime. */
  #liveClient(id: string): ClientRow | null {
    const c = this.#client(id);
    if (!c || c.approved_at) return c;
    const cutoff = new Date(this.#now().getTime() - this.#pendingTtlMs).toISOString();
    return c.created_at < cutoff ? null : c;
  }

  #client(id: string): ClientRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM app_client WHERE id = ?').get(id) as
        ClientRow | undefined) ?? null
    );
  }

  #authorization(id: string): AuthorizationRow | null {
    return (
      (this.#db.raw
        .prepare(
          `SELECT id, account_id, kind, client_name, scopes, status, created_at, last_used_at
             FROM app_authorization WHERE id = ?`,
        )
        .get(id) as AuthorizationRow | undefined) ?? null
    );
  }

  /** The account's active authorization of this client, if any. */
  #activeGrant(accountId: string, clientId: string): AuthorizationRow | null {
    return (
      (this.#db.raw
        .prepare(
          `SELECT a.id, a.account_id, a.kind, a.client_name, a.scopes, a.status, a.created_at,
                  a.last_used_at
             FROM app_consent k JOIN app_authorization a ON a.id = k.authorization_id
            WHERE k.account_id = ? AND k.client_id = ? AND a.status = 'active' AND a.kind = 'app'
            ORDER BY a.created_at DESC LIMIT 1`,
        )
        .get(accountId, clientId) as AuthorizationRow | undefined) ?? null
    );
  }

  #token(token: string, kind: 'access' | 'refresh' | null): TokenRow | null {
    if (!token.startsWith('nva_') || token.length > 200) return null;
    const row = this.#db.raw
      .prepare('SELECT * FROM app_token WHERE token_hash = ?')
      .get(hashToken(token)) as TokenRow | undefined;
    if (!row || (kind && row.kind !== kind)) return null;
    return row;
  }

  #revokeFamily(familyId: string, now: string): number {
    const res = this.#db.raw
      .prepare('UPDATE app_token SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
      .run(now, familyId);
    return Number(res.changes);
  }

  /** A new access and refresh token in a family (inside the caller's transaction). */
  #issue(
    from: { client_id: string; account_id: string; authorization_id: string },
    familyId: string,
    scopes: AppScope[],
    nowDate: Date,
  ): OAuthTokenResponse {
    const now = nowDate.toISOString();
    const access = newToken('app');
    const refresh = newToken('app');
    const insert = this.#db.raw.prepare(
      `INSERT INTO app_token (id, kind, token_hash, family_id, authorization_id, client_id,
         account_id, scopes, created_at, expires_at, used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    const at = (s: number) => new Date(nowDate.getTime() + s * 1000).toISOString();
    for (const [kind, token, ttl] of [
      ['access', access, APP_ACCESS_TOKEN_TTL_S],
      ['refresh', refresh, APP_REFRESH_TOKEN_TTL_S],
    ] as const)
      insert.run(
        uuidv7(),
        kind,
        hashToken(token),
        familyId,
        from.authorization_id,
        from.client_id,
        from.account_id,
        JSON.stringify(scopes),
        now,
        at(ttl),
      );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: APP_ACCESS_TOKEN_TTL_S,
      refresh_token: refresh,
      scope: formatScopes(scopes),
    };
  }

  async #log(rec: AuditRecord): Promise<void> {
    if (this.#audit) await this.#audit.append(rec);
  }
}

function intersect(a: readonly AppScope[], b: readonly AppScope[]): AppScope[] {
  return sortScopes(a.filter((s) => b.includes(s)));
}

/** Where a redirect URI goes, for the owner's list: a loopback host[:port] or a private scheme. */
function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' ? u.host : u.protocol.slice(0, -1);
  } catch {
    return uri.slice(0, 100);
  }
}

function readJsonArray(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
