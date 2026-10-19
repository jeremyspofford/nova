// OAuth state for remote MCP servers (FR-047): the authorization flow with a single-use state bound
// to the account, tokens in the vault only, refresh before expiry and after a 401, and revocation.
// Storage is the caller's: records go through `store`, token values through `vault`.
import { randomBytes } from 'node:crypto';
import type {
  AuthProvider,
  AuthorizationServerMetadata,
  FetchLike,
} from '@modelcontextprotocol/client';
import { NovaError, type McpAuthView } from '@nova/shared';
import { Logger } from '@nova/telemetry';
import {
  beginAuthorization,
  completeAuthorization,
  discoverOAuth,
  refreshOAuth,
  registerOAuthClient,
  revokeOAuth,
  type OAuthClientRegistration,
  type OAuthDiscovery,
  type OAuthTokenSet,
} from './oauth.ts';

export type OAuthStatus = 'needs_auth' | 'connected' | 'expired' | 'error';

/** One server's OAuth record (the `mcp_oauth` row). Token values are never in it. */
export interface OAuthRecord {
  serverId: string;
  accountId: string;
  issuer: string;
  metadata: AuthorizationServerMetadata;
  resource: string | null;
  clientId: string;
  clientSecretRef: string | null;
  registration: 'metadata_document' | 'dynamic';
  scopes: string[];
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  status: OAuthStatus;
  expiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthVault {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<unknown>;
}

export interface OAuthRecordStore {
  save(record: OAuthRecord): Promise<void>;
  remove(serverId: string): Promise<void>;
}

export interface McpOAuthOptions {
  vault: OAuthVault;
  store: OAuthRecordStore;
  /** Records saved earlier (loaded at startup). */
  records?: OAuthRecord[];
  fetchFn?: FetchLike;
  /**
   * The fetch one account's discovery, registration and token calls use (the Hub pins a
   * non-owner's to checked public addresses); `fetchFn` when it gives none.
   */
  fetchFor?: (accountId: string) => FetchLike | undefined;
  now?: () => Date;
  /** How long an authorization may take before its state expires (default 10 min). */
  stateTtlMs?: number;
  /** Refresh this long before the access token expires (default 60 s). */
  refreshSkewMs?: number;
  log?: Logger;
  /** A server's tokens changed (connected, refreshed after a failure, revoked). */
  onChange?: (serverId: string) => void;
}

interface Pending {
  serverId: string;
  accountId: string;
  codeVerifier: string;
  redirectUrl: string;
  discovery: OAuthDiscovery;
  client: OAuthClientRegistration;
  scopes: string[];
  expiresAt: number;
}

const MAX_PENDING = 100;

export const oauthRefs = (serverId: string) => ({
  access: `secret://mcp/${serverId}/oauth/access_token`,
  refresh: `secret://mcp/${serverId}/oauth/refresh_token`,
  clientSecret: `secret://mcp/${serverId}/oauth/client_secret`,
});

export class McpOAuthService {
  readonly #o: McpOAuthOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #records = new Map<string, OAuthRecord>();
  readonly #pending = new Map<string, Pending>();
  readonly #refreshing = new Map<string, Promise<void>>();

  constructor(opts: McpOAuthOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'mcp.oauth', sinks: [] });
    for (const r of opts.records ?? []) this.#records.set(r.serverId, r);
  }

  #fetch(accountId: string): FetchLike | undefined {
    return this.#o.fetchFor?.(accountId) ?? this.#o.fetchFn;
  }

  record(serverId: string): OAuthRecord | null {
    return this.#records.get(serverId) ?? null;
  }

  /** How the server's OAuth looks in settings, or null when it has none. */
  view(serverId: string): McpAuthView | null {
    const r = this.#records.get(serverId);
    if (!r) return null;
    let status = r.status;
    if (
      status === 'connected' &&
      !r.refreshTokenRef &&
      r.expiresAt &&
      r.expiresAt <= this.#now().toISOString()
    )
      status = 'expired';
    return { kind: 'oauth', status, expiresAt: r.expiresAt, scopes: [...r.scopes] };
  }

  /**
   * Begin authorizing: discover the authorization server, register Nova (client metadata
   * document or dynamic registration, reused when it is the same server), and return the URL the
   * user opens. The state is random, single-use and remembers the account.
   */
  async start(input: {
    serverId: string;
    accountId: string;
    serverUrl: string;
    redirectUrl: string;
    clientMetadataUrl: string | null;
    scopes?: string[];
  }): Promise<{ authorizeUrl: string }> {
    const fetchFn = this.#fetch(input.accountId);
    const discovery = await discoverOAuth(input.serverUrl, fetchFn);
    const scopes = input.scopes?.length ? input.scopes : discovery.scopesSupported;
    const prev = this.#records.get(input.serverId);
    let client: OAuthClientRegistration;
    if (
      prev &&
      prev.issuer === discovery.authorizationServerUrl &&
      (prev.registration === 'dynamic' || prev.clientId === input.clientMetadataUrl)
    ) {
      client = {
        clientId: prev.clientId,
        clientSecret: prev.clientSecretRef ? await this.#o.vault.get(prev.clientSecretRef) : null,
        method: prev.registration,
      };
    } else {
      client = await registerOAuthClient(discovery, {
        clientMetadataUrl: input.clientMetadataUrl,
        redirectUrl: input.redirectUrl,
        scopes,
        ...(fetchFn ? { fetchFn } : {}),
      });
    }
    const refs = oauthRefs(input.serverId);
    if (client.clientSecret) await this.#o.vault.put(refs.clientSecret, client.clientSecret);
    const nowIso = this.#now().toISOString();
    const rec: OAuthRecord = {
      serverId: input.serverId,
      accountId: input.accountId,
      issuer: discovery.authorizationServerUrl,
      metadata: discovery.metadata,
      resource: discovery.resource,
      clientId: client.clientId,
      clientSecretRef: client.clientSecret ? refs.clientSecret : null,
      registration: client.method,
      scopes,
      accessTokenRef: prev?.accessTokenRef ?? null,
      refreshTokenRef: prev?.refreshTokenRef ?? null,
      status: prev?.accessTokenRef ? prev.status : 'needs_auth',
      expiresAt: prev?.expiresAt ?? null,
      lastError: null,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await this.#save(rec);
    const state = randomBytes(32).toString('base64url');
    const { authorizeUrl, codeVerifier } = await beginAuthorization(discovery, client, {
      redirectUrl: input.redirectUrl,
      state,
      scopes,
    });
    this.#sweep();
    this.#pending.set(state, {
      serverId: input.serverId,
      accountId: input.accountId,
      codeVerifier,
      redirectUrl: input.redirectUrl,
      discovery,
      client,
      scopes,
      expiresAt: this.#now().getTime() + (this.#o.stateTtlMs ?? 10 * 60_000),
    });
    return { authorizeUrl };
  }

  /**
   * The redirect back from the authorization server. The state is used up whatever happens; an
   * unknown, used or expired state is refused before anything else is looked at.
   */
  async finish(input: {
    state: string;
    code?: string | undefined;
    error?: string | undefined;
    iss?: string | undefined;
  }): Promise<{ serverId: string; accountId: string; ok: boolean; error: string | null }> {
    this.#sweep();
    const p = this.#pending.get(input.state);
    this.#pending.delete(input.state);
    if (!p)
      throw new NovaError('request_expired', 'this authorization link is unknown, used or expired');
    const rec = this.#records.get(p.serverId);
    if (!rec) throw new NovaError('not_found', 'the MCP server was removed');
    const failed = async (message: string) => {
      await this.#save({
        ...rec,
        status: rec.accessTokenRef ? rec.status : 'error',
        lastError: message,
        updatedAt: this.#now().toISOString(),
      });
      return { serverId: p.serverId, accountId: p.accountId, ok: false, error: message };
    };
    if (input.error || !input.code)
      return failed(
        input.error
          ? `authorization was refused (${input.error.slice(0, 100)})`
          : 'no code came back',
      );
    let tokens: OAuthTokenSet;
    try {
      tokens = await completeAuthorization(p.discovery, p.client, {
        code: input.code,
        codeVerifier: p.codeVerifier,
        redirectUrl: p.redirectUrl,
        scopes: p.scopes,
        ...(input.iss ? { iss: input.iss } : {}),
        ...(this.#fetch(p.accountId) ? { fetchFn: this.#fetch(p.accountId) } : {}),
        now: this.#now(),
      });
    } catch (err) {
      return failed(err instanceof Error ? err.message : 'the code exchange failed');
    }
    await this.#store(rec, tokens);
    this.#o.onChange?.(p.serverId);
    return { serverId: p.serverId, accountId: p.accountId, ok: true, error: null };
  }

  /** The token provider for a server's connection; null when the server has no OAuth record. */
  provider(serverId: string): AuthProvider | null {
    if (!this.#records.has(serverId)) return null;
    return {
      token: () => this.accessToken(serverId),
      onUnauthorized: async () => {
        await this.accessToken(serverId, { force: true });
      },
    };
  }

  /** The current access token, refreshed first when it expires within the skew (or `force`). */
  async accessToken(serverId: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
    const rec = this.#records.get(serverId);
    if (!rec?.accessTokenRef) return undefined;
    const skew = this.#o.refreshSkewMs ?? 60_000;
    const due =
      opts.force ||
      (rec.expiresAt !== null && new Date(rec.expiresAt).getTime() - skew <= this.#now().getTime());
    if (due) await this.#refresh(serverId);
    const cur = this.#records.get(serverId);
    if (!cur?.accessTokenRef) return undefined;
    return (await this.#o.vault.get(cur.accessTokenRef)) ?? undefined;
  }

  /** Revoke at the server (best effort) and forget the tokens; the server needs authorizing again. */
  async revoke(serverId: string): Promise<void> {
    const rec = this.#records.get(serverId);
    if (!rec) return;
    const d: OAuthDiscovery = {
      authorizationServerUrl: rec.issuer,
      metadata: rec.metadata,
      resource: rec.resource,
      scopesSupported: [],
    };
    const client = await this.#client(rec);
    for (const [ref, hint] of [
      [rec.refreshTokenRef, 'refresh_token'],
      [rec.accessTokenRef, 'access_token'],
    ] as const) {
      if (!ref) continue;
      const token = await this.#o.vault.get(ref);
      if (token) await revokeOAuth(d, client, token, hint, this.#fetch(rec.accountId));
      await this.#o.vault.delete(ref);
    }
    await this.#save({
      ...rec,
      accessTokenRef: null,
      refreshTokenRef: null,
      status: 'needs_auth',
      expiresAt: null,
      lastError: null,
      updatedAt: this.#now().toISOString(),
    });
    for (const [state, p] of this.#pending)
      if (p.serverId === serverId) this.#pending.delete(state);
    this.#o.onChange?.(serverId);
  }

  /** The server was removed: drop its record and pending flows (its vault entries go with it). */
  async forget(serverId: string): Promise<void> {
    this.#records.delete(serverId);
    for (const [state, p] of this.#pending)
      if (p.serverId === serverId) this.#pending.delete(state);
    await this.#o.store.remove(serverId);
  }

  async #client(rec: OAuthRecord): Promise<OAuthClientRegistration> {
    return {
      clientId: rec.clientId,
      clientSecret: rec.clientSecretRef ? await this.#o.vault.get(rec.clientSecretRef) : null,
      method: rec.registration,
    };
  }

  #refresh(serverId: string): Promise<void> {
    const running = this.#refreshing.get(serverId);
    if (running) return running;
    const run = this.#doRefresh(serverId).finally(() => this.#refreshing.delete(serverId));
    this.#refreshing.set(serverId, run);
    return run;
  }

  async #doRefresh(serverId: string): Promise<void> {
    const rec = this.#records.get(serverId);
    if (!rec) return;
    const refresh = rec.refreshTokenRef ? await this.#o.vault.get(rec.refreshTokenRef) : null;
    if (!refresh) {
      if (rec.status !== 'expired')
        await this.#save({ ...rec, status: 'expired', updatedAt: this.#now().toISOString() });
      return;
    }
    try {
      const tokens = await refreshOAuth(
        {
          authorizationServerUrl: rec.issuer,
          metadata: rec.metadata,
          resource: rec.resource,
          scopesSupported: [],
        },
        await this.#client(rec),
        refresh,
        {
          scopes: rec.scopes,
          ...(this.#fetch(rec.accountId) ? { fetchFn: this.#fetch(rec.accountId) } : {}),
          now: this.#now(),
        },
      );
      await this.#store(rec, tokens);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('mcp oauth refresh failed', { serverId, error: message });
      await this.#save({
        ...rec,
        status: /invalid_grant|expired|revoked/i.test(message) ? 'expired' : 'error',
        lastError: message.slice(0, 500),
        updatedAt: this.#now().toISOString(),
      });
    }
  }

  async #store(rec: OAuthRecord, tokens: OAuthTokenSet): Promise<void> {
    const refs = oauthRefs(rec.serverId);
    await this.#o.vault.put(refs.access, tokens.accessToken);
    if (tokens.refreshToken) await this.#o.vault.put(refs.refresh, tokens.refreshToken);
    else await this.#o.vault.delete(refs.refresh);
    await this.#save({
      ...rec,
      accessTokenRef: refs.access,
      refreshTokenRef: tokens.refreshToken ? refs.refresh : null,
      scopes: tokens.scopes,
      status: 'connected',
      expiresAt: tokens.expiresAt,
      lastError: null,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #save(rec: OAuthRecord): Promise<void> {
    this.#records.set(rec.serverId, rec);
    await this.#o.store.save(rec);
  }

  #sweep(): void {
    const now = this.#now().getTime();
    for (const [state, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(state);
    // Oldest first: a flood of abandoned authorizations cannot grow without bound.
    while (this.#pending.size >= MAX_PENDING) {
      const first = this.#pending.keys().next().value;
      if (first === undefined) break;
      this.#pending.delete(first);
    }
  }
}
