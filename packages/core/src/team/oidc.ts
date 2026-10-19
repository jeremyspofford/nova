// OpenID Connect pieces for optional sign-in (FR-113, docs/13 §7): discovery, PKCE (S256), the
// authorization code exchange and ID token verification, all on node:crypto (no hand-rolled
// primitives). An ID token is accepted only when its JWS signature verifies with a key from the
// provider's JWKS (RSA, RSA-PSS, ECDSA or EdDSA; never `none` or a shared-secret HMAC), its issuer
// is the configured one, its audience names this client (and `azp` does when there are several),
// it has not expired, and its nonce is the one this Hub sent. Anything else fails closed.
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  constants as cryptoConstants,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/** Why a sign-in was refused; the code is shown, never the token. */
export type OidcFailure =
  | 'discovery'
  | 'token_exchange'
  | 'malformed'
  | 'algorithm'
  | 'key'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'nonce'
  | 'subject';

export class OidcError extends Error {
  readonly reason: OidcFailure;
  constructor(reason: OidcFailure, message: string) {
    super(message);
    this.name = 'OidcError';
    this.reason = reason;
  }
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The JWS algorithms accepted (RFC 7518): asymmetric only. */
export const OIDC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
type Alg = (typeof OIDC_ALGORITHMS)[number];

const MAX_BODY = 256 * 1024;
const MAX_TOKEN = 16 * 1024;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** https only; http only when the issuer itself is on this machine (a local provider, tests). */
function checkEndpoint(issuer: string, url: unknown, name: string): string {
  if (typeof url !== 'string' || url.length > 2048)
    throw new OidcError('discovery', `the provider did not give a ${name}`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OidcError('discovery', `the provider's ${name} is not a URL`);
  }
  const local = isLoopback(new URL(issuer).hostname) && isLoopback(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
    throw new OidcError('discovery', `the provider's ${name} must use https`);
  if (u.username || u.password)
    throw new OidcError('discovery', `the provider's ${name} must not carry credentials`);
  return u.toString();
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('response too large');
  return JSON.parse(text) as unknown;
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([t, signal]) : t;
}

/** OpenID Provider metadata (OIDC Discovery §4); the document must name the same issuer. */
export async function discover(
  issuer: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/+$/, '');
  let doc: unknown;
  try {
    const res = await fetchFn(`${base}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(10_000, signal),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await readJson(res);
  } catch (err) {
    throw new OidcError(
      'discovery',
      `the provider's configuration could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d.issuer !== issuer && d.issuer !== base)
    throw new OidcError('discovery', 'the provider names a different issuer');
  return {
    issuer: d.issuer,
    authorization_endpoint: checkEndpoint(
      issuer,
      d.authorization_endpoint,
      'authorization endpoint',
    ),
    token_endpoint: checkEndpoint(issuer, d.token_endpoint, 'token endpoint'),
    jwks_uri: checkEndpoint(issuer, d.jwks_uri, 'key set'),
  };
}

/** The provider's signing keys (JWKS). */
export async function fetchJwks(
  discovery: OidcDiscovery,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<JsonWebKey[]> {
  try {
    const res = await fetchFn(discovery.jwks_uri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(10_000, signal),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await readJson(res)) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error('no keys');
    return body.keys
      .filter((k): k is JsonWebKey => typeof k === 'object' && k !== null)
      .slice(0, 50);
  } catch (err) {
    throw new OidcError(
      'key',
      `the provider's keys could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The authorization request URL (code flow with PKCE, OIDC Core §3.1.2.1). */
export function authorizationUrl(
  discovery: OidcDiscovery,
  p: {
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    state: string;
    nonce: string;
    challenge: string;
  },
): string {
  const u = new URL(discovery.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', p.scopes.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** Exchange the code at the token endpoint; client_secret_basic when there is a secret. */
export async function exchangeCode(
  discovery: OidcDiscovery,
  p: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string | null;
    verifier: string;
  },
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    client_id: p.clientId,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (p.clientSecret) {
    // RFC 6749 §2.3.1: both parts form-encoded before base64.
    const basic = `${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
  }
  let json: Record<string, unknown>;
  try {
    const res = await fetchFn(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: 'error',
      signal: timeoutSignal(15_000, signal),
    });
    json = ((await readJson(res)) ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      const e = typeof json.error === 'string' ? json.error.slice(0, 100) : `HTTP ${res.status}`;
      throw new Error(e);
    }
  } catch (err) {
    throw new OidcError(
      'token_exchange',
      `the provider refused the sign-in code: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof json.id_token !== 'string' || !json.id_token)
    throw new OidcError('token_exchange', 'the provider returned no ID token');
  return { idToken: json.id_token };
}

function decodeSegment(seg: string | undefined): Record<string, unknown> {
  if (!seg || !/^[A-Za-z0-9_-]+$/.test(seg)) throw new OidcError('malformed', 'not a JWT');
  try {
    const v = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new OidcError('malformed', 'the token is not valid JSON');
  }
}

function pickKey(keys: readonly JsonWebKey[], alg: Alg, kid: string | undefined): KeyObject {
  const kty = alg.startsWith('ES') ? 'EC' : alg === 'EdDSA' ? 'OKP' : 'RSA';
  const usable = keys.filter(
    (k) =>
      k.kty === kty &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === alg),
  );
  const matching = kid ? usable.filter((k) => k.kid === kid) : usable;
  // Without a kid, only an unambiguous key set may be used.
  const jwk = matching.length === 1 ? matching[0] : undefined;
  if (!jwk) throw new OidcError('key', 'no signing key of the provider matches the token');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new OidcError('key', "the provider's signing key cannot be read");
  }
  const problem = weakKey(alg, key);
  if (problem) throw new OidcError('key', problem);
  return key;
}

/** EC curve for each ECDSA algorithm (RFC 7518 §3.4). */
const CURVES: Partial<Record<Alg, string>> = {
  ES256: 'prime256v1',
  ES384: 'secp384r1',
  ES512: 'secp521r1',
};

/** Why a key must not verify tokens of `alg`: an RSA key under 2048 bits, the wrong curve. */
function weakKey(alg: Alg, key: KeyObject): string | null {
  const type = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails ?? {};
  if (alg.startsWith('RS') || alg.startsWith('PS')) {
    if (type !== 'rsa' && type !== 'rsa-pss') return 'the signing key is not an RSA key';
    if ((d.modulusLength ?? 0) < 2048) return 'the RSA signing key is shorter than 2048 bits';
    return null;
  }
  if (alg === 'EdDSA')
    return type === 'ed25519' || type === 'ed448' ? null : 'the signing key is not an EdDSA key';
  if (type !== 'ec' || d.namedCurve !== CURVES[alg])
    return `the signing key's curve does not match ${alg}`;
  return null;
}

function checkSignature(alg: Alg, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  const bits = alg === 'EdDSA' ? null : alg.slice(2);
  const hash = bits ? `sha${bits}` : null;
  if (alg === 'EdDSA') return verifySignature(null, data, key, sig);
  if (alg.startsWith('RS')) return verifySignature(hash, data, key, sig);
  if (alg.startsWith('PS'))
    return verifySignature(
      hash,
      data,
      {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: Number(bits) / 8,
      },
      sig,
    );
  return verifySignature(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
}

export interface VerifyIdTokenOptions {
  issuer: string;
  clientId: string;
  nonce: string;
  keys: readonly JsonWebKey[];
  now: Date;
  /** Allowed clock skew (seconds); default 60. */
  skewS?: number;
}

/** Verify an ID token (OIDC Core §3.1.3.7). Throws OidcError with the failing check. */
export function verifyIdToken(token: string, o: VerifyIdTokenOptions): IdTokenClaims {
  if (typeof token !== 'string' || token.length > MAX_TOKEN)
    throw new OidcError('malformed', 'the token is too large');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('malformed', 'not a signed JWT');
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  const alg = header.alg;
  if (typeof alg !== 'string' || !(OIDC_ALGORITHMS as readonly string[]).includes(alg))
    throw new OidcError('algorithm', `the token's algorithm ${String(alg)} is not accepted`);
  if (header.crit !== undefined)
    throw new OidcError('algorithm', 'critical headers are not supported');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const key = pickKey(o.keys, alg as Alg, kid);
  const sigSeg = parts[2] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(sigSeg))
    throw new OidcError('malformed', 'the signature is not base64url');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  let good: boolean;
  try {
    good = checkSignature(alg as Alg, key, data, Buffer.from(sigSeg, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) throw new OidcError('signature', 'the token signature does not verify');
  const skew = o.skewS ?? 60;
  const now = Math.floor(o.now.getTime() / 1000);
  if (claims.iss !== o.issuer) throw new OidcError('issuer', 'the token is from another issuer');
  const aud = claims.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.every((a) => typeof a === 'string') || !auds.includes(o.clientId))
    throw new OidcError('audience', 'the token is not for this Hub');
  if (auds.length > 1 && claims.azp !== o.clientId)
    throw new OidcError('audience', 'the token was issued to another party');
  if (claims.azp !== undefined && claims.azp !== o.clientId)
    throw new OidcError('audience', 'the token was issued to another party');
  if (typeof claims.exp !== 'number' || claims.exp + skew <= now)
    throw new OidcError('expired', 'the token has expired');
  if (typeof claims.iat === 'number' && claims.iat - skew > now)
    throw new OidcError('not_yet_valid', 'the token was issued in the future');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now)
    throw new OidcError('not_yet_valid', 'the token is not valid yet');
  if (typeof claims.nonce !== 'string' || claims.nonce !== o.nonce)
    throw new OidcError('nonce', 'the token does not answer this sign-in');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255)
    throw new OidcError('subject', 'the token names no subject');
  return claims as IdTokenClaims;
}
