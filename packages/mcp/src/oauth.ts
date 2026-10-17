// OAuth 2.1 with PKCE for remote MCP servers (FR-047; docs/08 §2.1 "Authentication"). Built on the
// SDK's discovery, registration and token helpers; the Hub keeps the state, the vault keeps the
// tokens. Nova registers either with a client metadata document (its client id is an HTTPS URL the
// Hub serves) or, when the authorization server offers it, with dynamic client registration.
import {
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { NovaError } from '@nova/shared';

export interface OAuthDiscovery {
  /** The authorization server (its issuer). */
  authorizationServerUrl: string;
  /** RFC 8414 metadata: the endpoints and what the server supports. */
  metadata: AuthorizationServerMetadata;
  /** RFC 8707 resource indicator from the protected-resource metadata, sent verbatim. */
  resource: string | null;
  /** Scopes the resource advertises (requested when the server entry names none). */
  scopesSupported: string[];
}

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret: string | null;
  method: 'metadata_document' | 'dynamic';
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time, or null when the server gave no lifetime. */
  expiresAt: string | null;
  scopes: string[];
}

const NAME = 'Nova';

const flowError = (message: string, cause?: unknown) =>
  new NovaError('validation', message, cause === undefined ? {} : { cause });

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Find the authorization server for an MCP server URL (RFC 9728, then RFC 8414 / OIDC). */
export async function discoverOAuth(
  serverUrl: string,
  fetchFn?: FetchLike,
): Promise<OAuthDiscovery> {
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(serverUrl, fetchFn ? { fetchFn } : {});
  } catch (err) {
    throw flowError(`could not discover the server's authorization: ${errText(err)}`, err);
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw flowError('the server does not publish OAuth authorization server metadata');
  // OAuth 2.1 requires PKCE; a server that does not say it supports S256 is refused.
  const methods = (metadata as { code_challenge_methods_supported?: unknown })
    .code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256'))
    throw flowError('the authorization server does not support PKCE with S256');
  const rm = info.resourceMetadata as
    { resource?: unknown; scopes_supported?: unknown } | undefined;
  const resource = typeof rm?.resource === 'string' ? rm.resource : null;
  if (
    resource &&
    !checkResourceAllowed({ requestedResource: serverUrl, configuredResource: resource })
  )
    throw flowError(`the protected resource ${resource} does not match ${serverUrl}`);
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource,
    scopesSupported: Array.isArray(rm?.scopes_supported)
      ? rm.scopes_supported.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/** The client metadata document the Hub serves at `clientMetadataUrl` (its own client id). */
export function clientMetadataDocument(
  clientMetadataUrl: string,
  redirectUrl: string,
  clientUri?: string,
) {
  return {
    client_id: clientMetadataUrl,
    client_name: NAME,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Register Nova with the authorization server: a client metadata document when the server
 * accepts one and the Hub has an HTTPS URL for it, else dynamic client registration when the
 * server offers it. Anything else is a clear error.
 */
export async function registerOAuthClient(
  d: OAuthDiscovery,
  opts: {
    clientMetadataUrl: string | null;
    redirectUrl: string;
    scopes: string[];
    fetchFn?: FetchLike;
  },
): Promise<OAuthClientRegistration> {
  const m = d.metadata as {
    client_id_metadata_document_supported?: unknown;
    registration_endpoint?: unknown;
  };
  const cimd = opts.clientMetadataUrl?.startsWith('https://') ? opts.clientMetadataUrl : null;
  if (cimd && m.client_id_metadata_document_supported === true)
    return { clientId: cimd, clientSecret: null, method: 'metadata_document' };
  if (typeof m.registration_endpoint === 'string') {
    try {
      const info = await registerClient(d.authorizationServerUrl, {
        metadata: d.metadata,
        clientMetadata: {
          client_name: NAME,
          redirect_uris: [opts.redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        ...(opts.scopes.length ? { scope: opts.scopes.join(' ') } : {}),
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      });
      const secret = (info as { client_secret?: unknown }).client_secret;
      return {
        clientId: info.client_id,
        clientSecret: typeof secret === 'string' && secret ? secret : null,
        method: 'dynamic',
      };
    } catch (err) {
      throw flowError(`client registration failed: ${errText(err)}`, err);
    }
  }
  throw flowError(
    cimd
      ? 'the authorization server accepts neither a client metadata document nor dynamic registration'
      : 'the authorization server does not offer dynamic registration, and a client metadata document needs the Hub to be reachable over HTTPS',
  );
}

function clientInfo(c: OAuthClientRegistration) {
  return c.clientSecret
    ? { client_id: c.clientId, client_secret: c.clientSecret }
    : { client_id: c.clientId };
}

/** The authorization URL (PKCE S256) and the verifier to keep until the callback. */
export async function beginAuthorization(
  d: OAuthDiscovery,
  client: OAuthClientRegistration,
  opts: { redirectUrl: string; state: string; scopes: string[] },
): Promise<{ authorizeUrl: string; codeVerifier: string }> {
  const { authorizationUrl, codeVerifier } = await startAuthorization(d.authorizationServerUrl, {
    metadata: d.metadata,
    clientInformation: clientInfo(client),
    redirectUrl: opts.redirectUrl,
    state: opts.state,
    ...(opts.scopes.length ? { scope: opts.scopes.join(' ') } : {}),
    ...(d.resource ? { resource: d.resource } : {}),
  });
  return { authorizeUrl: authorizationUrl.href, codeVerifier };
}

function tokenSet(t: OAuthTokens, now: Date, fallbackScopes: string[]): OAuthTokenSet {
  const raw = t as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (typeof raw.access_token !== 'string' || !raw.access_token)
    throw flowError('the authorization server returned no access token');
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : null,
    expiresAt:
      typeof raw.expires_in === 'number' && raw.expires_in > 0
        ? new Date(now.getTime() + raw.expires_in * 1000).toISOString()
        : null,
    scopes: typeof raw.scope === 'string' ? raw.scope.split(/\s+/).filter(Boolean) : fallbackScopes,
  };
}

/** Exchange the authorization code from the callback for tokens. */
export async function completeAuthorization(
  d: OAuthDiscovery,
  client: OAuthClientRegistration,
  opts: {
    code: string;
    codeVerifier: string;
    redirectUrl: string;
    iss?: string;
    scopes: string[];
    fetchFn?: FetchLike;
    now?: Date;
  },
): Promise<OAuthTokenSet> {
  try {
    const t = await exchangeAuthorization(d.authorizationServerUrl, {
      metadata: d.metadata,
      clientInformation: clientInfo(client),
      authorizationCode: opts.code,
      codeVerifier: opts.codeVerifier,
      redirectUri: opts.redirectUrl,
      ...(opts.iss ? { iss: opts.iss } : {}),
      ...(d.resource ? { resource: d.resource } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    return tokenSet(t, opts.now ?? new Date(), opts.scopes);
  } catch (err) {
    if (err instanceof NovaError) throw err;
    throw flowError(`the authorization code was not accepted: ${errText(err)}`, err);
  }
}

/** Trade a refresh token for new tokens; a server that sends no new refresh token keeps the old one. */
export async function refreshOAuth(
  d: OAuthDiscovery,
  client: OAuthClientRegistration,
  refreshToken: string,
  opts: { scopes: string[]; fetchFn?: FetchLike; now?: Date } = { scopes: [] },
): Promise<OAuthTokenSet> {
  try {
    const t = await refreshAuthorization(d.authorizationServerUrl, {
      metadata: d.metadata,
      clientInformation: clientInfo(client),
      refreshToken,
      ...(d.resource ? { resource: d.resource } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    const set = tokenSet(t, opts.now ?? new Date(), opts.scopes);
    return { ...set, refreshToken: set.refreshToken ?? refreshToken };
  } catch (err) {
    if (err instanceof NovaError) throw err;
    throw flowError(`the token could not be refreshed: ${errText(err)}`, err);
  }
}

/**
 * Revoke a token at the server's revocation endpoint (RFC 7009). Returns false when the server
 * has none or refuses; the caller forgets the token either way.
 */
export async function revokeOAuth(
  d: OAuthDiscovery,
  client: OAuthClientRegistration,
  token: string,
  hint: 'access_token' | 'refresh_token',
  fetchFn: FetchLike = fetch,
): Promise<boolean> {
  const endpoint = (d.metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
  if (typeof endpoint !== 'string') return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    return false;
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.clientId });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret)
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
