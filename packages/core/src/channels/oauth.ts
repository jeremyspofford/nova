// Email OAuth (M8; FR-110, docs/13 §4, docs/12 §5): a mailbox that signs in with SASL XOAUTH2
// instead of a password. The owner configures the provider (authorization and token endpoints,
// client id, scopes, and a client secret for a confidential client, kept in the vault); the
// authorization runs in the browser with PKCE (S256) and a random single-use state bound to the
// account and the binding, through the Hub's callback. The exchanges themselves are the Hub's
// (`ChannelOAuthFlows`, built on the MCP OAuth helpers of M4). Tokens are vault entries of the
// mailbox's credential group (`<secret_ref>/oauthAccessToken`, `…/oauthRefreshToken`), so the
// bindings of one mailbox share them and they go with the last binding; their state (status,
// expiry, scopes, last error) is the vault entry `…/oauthState`, never a row and never a token.
// The access token is refreshed within `refreshSkewMs` of its expiry (or when a server refused
// it), one refresh at a time per mailbox; a refused refresh token means authorizing again.
import { randomBytes } from 'node:crypto';
import {
  NovaError,
  type ChannelOAuthStartView,
  type ChannelOAuthStatus,
  type ChannelOAuthView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { AuditSink } from '../tools/types.ts';

/** A provider as the owner configured it on the binding. */
export interface ChannelOAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  clientId: string;
  /** A confidential client's secret (from the vault); null for a public client. */
  clientSecret: string | null;
  scopes: string[];
}

export interface ChannelOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time, or null when the provider gave no lifetime. */
  expiresAt: string | null;
  scopes: string[];
}

/**
 * The OAuth exchanges (authorization code with PKCE S256, refresh, RFC 7009 revocation). The Hub
 * implements them with the MCP OAuth helpers; `accountId` lets it pin a non-owner's calls to
 * public addresses.
 */
export interface ChannelOAuthFlows {
  begin(
    accountId: string,
    e: ChannelOAuthEndpoints,
    opts: { redirectUri: string; state: string },
  ): Promise<{ authorizeUrl: string; codeVerifier: string }>;
  complete(
    accountId: string,
    e: ChannelOAuthEndpoints,
    opts: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<ChannelOAuthTokens>;
  refresh(
    accountId: string,
    e: ChannelOAuthEndpoints,
    refreshToken: string,
  ): Promise<ChannelOAuthTokens>;
  /** Best effort; false when the provider has no revocation endpoint or refused. */
  revoke(
    accountId: string,
    e: ChannelOAuthEndpoints,
    token: string,
    hint: 'access_token' | 'refresh_token',
  ): Promise<boolean>;
}

export interface ChannelOAuthOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  flows: ChannelOAuthFlows;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  /** How long an authorization may take before its state expires (default 10 min). */
  stateTtlMs?: number;
  /** Refresh this long before the access token expires (default 60 s). */
  refreshSkewMs?: number;
  /** The mailbox was authorized or signed out (pollers restart; views change). */
  onChange?: (bindingId: string) => void;
}

/** The credential names under a mailbox's secret prefix. */
export const OAUTH_SECRET_NAMES = {
  clientSecret: 'oauthClientSecret',
  access: 'oauthAccessToken',
  refresh: 'oauthRefreshToken',
  state: 'oauthState',
} as const;

interface OAuthState {
  status: ChannelOAuthStatus;
  expiresAt: string | null;
  scopes: string[];
  authorizedAt: string | null;
  lastError: string | null;
}

interface Pending {
  accountId: string;
  bindingId: string;
  secretRef: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

interface BindingRow {
  id: string;
  account_id: string;
  kind: string;
  config_json: string | null;
  secret_ref: string | null;
}

const MAX_PENDING = 100;
const NONE: OAuthState = {
  status: 'needs_auth',
  expiresAt: null,
  scopes: [],
  authorizedAt: null,
  lastError: null,
};

function parseConfig(json: string | null): Record<string, string> {
  try {
    const v = JSON.parse(json ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (typeof x === 'string') out[k] = x;
    return out;
  } catch {
    return {};
  }
}

/** An error message fit to keep and show: redacted and short. */
function clean(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return defaultRedactor.redactString(text).slice(0, 300);
}

/** Whether an email binding's settings ask for OAuth. */
export function usesOAuth(config: Record<string, string | null | undefined>): boolean {
  return config.auth === 'oauth';
}

export class ChannelOAuth {
  readonly #o: ChannelOAuthOptions;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Pending>();
  readonly #refreshing = new Map<string, Promise<void>>();

  constructor(opts: ChannelOAuthOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
  }

  #row(bindingId: string, accountId?: string): BindingRow {
    const row = this.#o.db.raw
      .prepare(
        'SELECT id, account_id, kind, config_json, secret_ref FROM channel_binding WHERE id = ?',
      )
      .get(bindingId) as BindingRow | undefined;
    if (!row || (accountId !== undefined && row.account_id !== accountId))
      throw new NovaError('not_found', 'channel binding not found');
    if (row.kind !== 'email' || !usesOAuth(parseConfig(row.config_json)) || !row.secret_ref)
      throw new NovaError('validation', 'this binding does not sign in with OAuth', {
        details: { field: 'config.auth' },
      });
    return row;
  }

  #ref(secretRef: string, name: keyof typeof OAUTH_SECRET_NAMES): string {
    return `${secretRef}/${OAUTH_SECRET_NAMES[name]}`;
  }

  async #endpoints(row: BindingRow): Promise<ChannelOAuthEndpoints> {
    const c = parseConfig(row.config_json);
    if (!c.oauthAuthUrl || !c.oauthTokenUrl || !c.oauthClientId)
      throw new NovaError('validation', 'the OAuth provider is not configured', {
        details: { field: 'config' },
      });
    return {
      authUrl: c.oauthAuthUrl,
      tokenUrl: c.oauthTokenUrl,
      revokeUrl: c.oauthRevokeUrl ?? null,
      clientId: c.oauthClientId,
      clientSecret: await this.#o.secrets.get(this.#ref(row.secret_ref!, 'clientSecret')),
      scopes: (c.oauthScopes ?? '').split(/\s+/).filter(Boolean),
    };
  }

  async #state(secretRef: string): Promise<OAuthState> {
    const raw = await this.#o.secrets.get(this.#ref(secretRef, 'state'));
    if (!raw) return { ...NONE };
    try {
      const v = JSON.parse(raw) as Partial<OAuthState>;
      return {
        status: v.status ?? 'needs_auth',
        expiresAt: v.expiresAt ?? null,
        scopes: Array.isArray(v.scopes) ? v.scopes.filter((s) => typeof s === 'string') : [],
        authorizedAt: v.authorizedAt ?? null,
        lastError: v.lastError ?? null,
      };
    } catch {
      return { ...NONE };
    }
  }

  async #setState(secretRef: string, state: OAuthState): Promise<void> {
    await this.#o.secrets.put(this.#ref(secretRef, 'state'), JSON.stringify(state));
  }

  /** The mailbox's authorization, for the binding view. */
  async view(secretRef: string): Promise<ChannelOAuthView> {
    const s = await this.#state(secretRef);
    return { ...s, scopes: [...s.scopes] };
  }

  /**
   * Begin authorizing: the provider's page with PKCE and a random single-use state that names the
   * account and the binding. Nothing is stored until the callback succeeds.
   */
  async start(input: {
    accountId: string;
    bindingId: string;
    redirectUri: string;
  }): Promise<ChannelOAuthStartView> {
    const row = this.#row(input.bindingId, input.accountId);
    const e = await this.#endpoints(row);
    const state = randomBytes(32).toString('base64url');
    const { authorizeUrl, codeVerifier } = await this.#o.flows.begin(input.accountId, e, {
      redirectUri: input.redirectUri,
      state,
    });
    this.#sweep();
    const expiresAt = this.#now().getTime() + (this.#o.stateTtlMs ?? 10 * 60_000);
    this.#pending.set(state, {
      accountId: input.accountId,
      bindingId: row.id,
      secretRef: row.secret_ref!,
      codeVerifier,
      redirectUri: input.redirectUri,
      expiresAt,
    });
    await this.#audit(input.accountId, 'user', 'channel.oauth.start', row.id, {
      scopes: e.scopes,
    });
    return {
      authorizeUrl,
      redirectUri: input.redirectUri,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The provider sent the browser back. The state is used up whatever happens; an unknown, used
   * or expired one is refused before anything else is read.
   */
  async finish(input: {
    state: string;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<{ accountId: string; bindingId: string; ok: boolean; error: string | null }> {
    this.#sweep();
    const p = this.#pending.get(input.state);
    this.#pending.delete(input.state);
    if (!p)
      throw new NovaError('request_expired', 'this authorization link is unknown, used or expired');
    let row: BindingRow;
    try {
      row = this.#row(p.bindingId, p.accountId);
    } catch {
      throw new NovaError('not_found', 'the channel binding was removed or changed');
    }
    const prev = await this.#state(p.secretRef);
    const failed = async (message: string) => {
      // A failed new authorization leaves working tokens as they were.
      await this.#setState(p.secretRef, {
        ...prev,
        status: prev.status === 'connected' ? 'connected' : 'error',
        lastError: message,
      });
      await this.#audit(p.accountId, 'user', 'channel.oauth.failed', row.id, { error: message });
      return { accountId: p.accountId, bindingId: row.id, ok: false, error: message };
    };
    if (input.error || !input.code)
      return failed(
        input.error
          ? `authorization was refused (${input.error.slice(0, 100)})`
          : 'no code came back',
      );
    let tokens: ChannelOAuthTokens;
    try {
      tokens = await this.#o.flows.complete(p.accountId, await this.#endpoints(row), {
        code: input.code,
        codeVerifier: p.codeVerifier,
        redirectUri: p.redirectUri,
      });
    } catch (err) {
      return failed(clean(err));
    }
    await this.#store(p.secretRef, tokens, this.#now().toISOString());
    await this.#audit(p.accountId, 'user', 'channel.oauth.connect', row.id, {
      scopes: tokens.scopes,
    });
    this.#o.onChange?.(row.id);
    return { accountId: p.accountId, bindingId: row.id, ok: true, error: null };
  }

  async #store(secretRef: string, t: ChannelOAuthTokens, authorizedAt: string | null) {
    const prev = await this.#state(secretRef);
    await this.#o.secrets.put(this.#ref(secretRef, 'access'), t.accessToken);
    if (t.refreshToken) await this.#o.secrets.put(this.#ref(secretRef, 'refresh'), t.refreshToken);
    await this.#setState(secretRef, {
      status: 'connected',
      expiresAt: t.expiresAt,
      scopes: t.scopes,
      authorizedAt: authorizedAt ?? prev.authorizedAt,
      lastError: null,
    });
  }

  /**
   * The mailbox's access token, refreshed first when it expires within the skew or `force` (a
   * server refused it). `token_required` when the mailbox must be authorized (again).
   */
  async accessToken(bindingId: string, opts: { force?: boolean } = {}): Promise<string> {
    const row = this.#row(bindingId);
    const ref = row.secret_ref!;
    const state = await this.#state(ref);
    const skew = this.#o.refreshSkewMs ?? 60_000;
    const due =
      opts.force ||
      (state.expiresAt !== null && Date.parse(state.expiresAt) - skew <= this.#now().getTime());
    if (due) await this.#refresh(row);
    const token = await this.#o.secrets.get(this.#ref(ref, 'access'));
    const now = await this.#state(ref);
    if (!token || now.status === 'needs_auth' || now.status === 'expired')
      throw new NovaError('token_required', 'the mailbox needs authorizing (OAuth) in Settings', {
        details: { reason: now.status === 'expired' ? 'oauth_expired' : 'oauth_needed' },
        action: 'Authorize the mailbox again in Settings → Channels',
      });
    return token;
  }

  #refresh(row: BindingRow): Promise<void> {
    const ref = row.secret_ref!;
    const running = this.#refreshing.get(ref);
    if (running) return running;
    const run = this.#doRefresh(row).finally(() => this.#refreshing.delete(ref));
    this.#refreshing.set(ref, run);
    return run;
  }

  async #doRefresh(row: BindingRow): Promise<void> {
    const ref = row.secret_ref!;
    const state = await this.#state(ref);
    const refresh = await this.#o.secrets.get(this.#ref(ref, 'refresh'));
    if (!refresh) {
      if (state.status === 'connected') {
        await this.#setState(ref, { ...state, status: 'expired', lastError: 'no refresh token' });
        await this.#audit(row.account_id, 'system', 'channel.oauth.expired', row.id, {
          reason: 'no_refresh_token',
        });
      }
      return;
    }
    try {
      const t = await this.#o.flows.refresh(row.account_id, await this.#endpoints(row), refresh);
      // A provider that sends no new refresh token keeps the old one valid.
      await this.#store(ref, { ...t, refreshToken: t.refreshToken ?? refresh }, null);
    } catch (err) {
      const message = clean(err);
      const refused = /invalid_grant|expired|revoked/i.test(message);
      this.#o.log?.warn('mailbox token refresh failed', { bindingId: row.id, error: message });
      await this.#setState(ref, {
        ...state,
        status: refused ? 'expired' : 'error',
        lastError: message,
      });
      if (refused)
        await this.#audit(row.account_id, 'system', 'channel.oauth.expired', row.id, {
          reason: 'refresh_refused',
        });
      else
        throw new NovaError(
          'server_error',
          `the mailbox token could not be refreshed: ${message}`,
          {
            retryable: true,
          },
        );
    }
  }

  /** Sign out: revoke at the provider (best effort) and forget the tokens. */
  async revoke(accountId: string, bindingId: string): Promise<void> {
    const row = this.#row(bindingId, accountId);
    await this.revokeGroup(row);
    await this.#audit(accountId, 'user', 'channel.oauth.revoke', row.id, {});
    this.#o.onChange?.(row.id);
  }

  /** Revoke and forget a mailbox's tokens (signing out, or its last binding is removed). */
  async revokeGroup(row: {
    id: string;
    account_id: string;
    config_json: string | null;
    secret_ref: string | null;
  }): Promise<void> {
    if (!row.secret_ref) return;
    const ref = row.secret_ref;
    let e: ChannelOAuthEndpoints | null = null;
    try {
      e = await this.#endpoints({ ...row, kind: 'email' });
    } catch {
      // no provider configured: nothing to revoke at
    }
    for (const [name, hint] of [
      ['refresh', 'refresh_token'],
      ['access', 'access_token'],
    ] as const) {
      const token = await this.#o.secrets.get(this.#ref(ref, name));
      if (token && e?.revokeUrl)
        await this.#o.flows.revoke(row.account_id, e, token, hint).catch(() => false);
      await this.#o.secrets.delete(this.#ref(ref, name));
    }
    await this.#setState(ref, { ...NONE });
    for (const [state, p] of this.#pending) if (p.secretRef === ref) this.#pending.delete(state);
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [state, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(state);
    // Oldest first: abandoned authorizations cannot grow without bound.
    while (this.#pending.size >= MAX_PENDING) {
      const first = this.#pending.keys().next().value;
      if (first === undefined) break;
      this.#pending.delete(first);
    }
  }

  async #audit(
    accountId: string,
    actor: string,
    action: string,
    bindingId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit?.append({
      accountId,
      actor,
      kind: 'channel',
      action,
      resource: `channel_binding:${bindingId}`,
      detail: { kind: 'email', ...detail },
    });
  }
}
