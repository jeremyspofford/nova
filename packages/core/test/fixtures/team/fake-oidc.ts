// A fake OpenID provider for the OIDC tests (FR-113): discovery, a key set, an authorization
// "page" that records the request and a token endpoint that checks PKCE and the client
// credentials, then mints an ID token. Every claim and the signing key can be overridden to make
// a bad token. It answers an injected fetch; nothing touches the network.
import {
  createHash,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

export type FakeAlg = 'RS256' | 'ES256' | 'EdDSA' | 'PS256';

export interface FakeLogin {
  state: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
}

function keysFor(alg: FakeAlg): { privateKey: KeyObject; publicKey: KeyObject } {
  if (alg === 'ES256') return generateKeyPairSync('ec', { namedCurve: 'P-256' });
  if (alg === 'EdDSA') return generateKeyPairSync('ed25519');
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

export function signJwt(
  alg: FakeAlg | 'none' | 'HS256',
  key: KeyObject | null,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc({ alg, typ: 'JWT', ...header })}.${enc(claims)}`;
  if (alg === 'none' || !key) return `${data}.`;
  if (alg === 'HS256') return `${data}.${Buffer.from('mac').toString('base64url')}`;
  let sig: Buffer;
  if (alg === 'EdDSA') sig = sign(null, Buffer.from(data), key);
  else if (alg === 'ES256')
    sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'PS256')
    sig = sign('sha256', Buffer.from(data), { key, padding: 6, saltLength: 32 });
  else sig = sign('sha256', Buffer.from(data), key);
  return `${data}.${sig.toString('base64url')}`;
}

export class FakeOidc {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly alg: FakeAlg;
  kid = 'key-1';
  #keys: { privateKey: KeyObject; publicKey: KeyObject };
  /** Logins the browser was sent to, newest last. */
  readonly logins: FakeLogin[] = [];
  readonly #codes = new Map<string, { login: FakeLogin; sub: string }>();
  /** Claims to merge into the next ID token (a bad audience, an old expiry...). */
  override: Record<string, unknown> = {};
  /** Sign the next token with another key (a bad signature). */
  wrongKey = false;
  jwksFetches = 0;
  tokenRequests: { auth: string | null; body: URLSearchParams }[] = [];

  constructor(
    opts: { issuer?: string; clientId?: string; clientSecret?: string | null; alg?: FakeAlg } = {},
  ) {
    this.issuer = opts.issuer ?? 'https://idp.test';
    this.clientId = opts.clientId ?? 'nova-hub';
    this.clientSecret = opts.clientSecret === undefined ? 'shh' : opts.clientSecret;
    this.alg = opts.alg ?? 'RS256';
    this.#keys = keysFor(this.alg);
  }

  /** Rotate the signing key under a new kid (the Hub must read the key set again). */
  rotate(kid = 'key-2'): void {
    this.#keys = keysFor(this.alg);
    this.kid = kid;
  }

  jwk(): JsonWebKey {
    return {
      ...this.#keys.publicKey.export({ format: 'jwk' }),
      kid: this.kid,
      use: 'sig',
      alg: this.alg,
    };
  }

  /** The user signs in at the provider as `sub`: the code the browser brings back. */
  approve(url: string, sub: string): { state: string; code: string } {
    const u = new URL(url);
    const login: FakeLogin = {
      state: u.searchParams.get('state') ?? '',
      nonce: u.searchParams.get('nonce') ?? '',
      challenge: u.searchParams.get('code_challenge') ?? '',
      redirectUri: u.searchParams.get('redirect_uri') ?? '',
      clientId: u.searchParams.get('client_id') ?? '',
    };
    this.logins.push(login);
    const code = `code-${this.logins.length}`;
    this.#codes.set(code, { login, sub });
    return { state: login.state, code };
  }

  idToken(login: FakeLogin, sub: string): string {
    const now = Math.floor(Date.now() / 1000);
    const key = this.wrongKey ? keysFor(this.alg).privateKey : this.#keys.privateKey;
    return signJwt(
      this.alg,
      key,
      { kid: this.kid },
      {
        iss: this.issuer,
        sub,
        aud: this.clientId,
        exp: now + 300,
        iat: now,
        nonce: login.nonce,
        email: `${sub}@idp.test`,
        name: `User ${sub}`,
        ...this.override,
      },
    );
  }

  readonly fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const json = (v: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(v), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url === `${this.issuer}/.well-known/openid-configuration`)
      return json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
      });
    if (url === `${this.issuer}/jwks`) {
      this.jwksFetches++;
      return json({ keys: [this.jwk()] });
    }
    if (url === `${this.issuer}/token` && init?.method === 'POST') {
      const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
      const headers = new Headers(init.headers);
      const auth = headers.get('authorization');
      this.tokenRequests.push({ auth, body });
      const entry = this.#codes.get(body.get('code') ?? '');
      if (!entry) return json({ error: 'invalid_grant' }, 400);
      this.#codes.delete(body.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (challenge !== entry.login.challenge) return json({ error: 'invalid_grant' }, 400);
      if (body.get('redirect_uri') !== entry.login.redirectUri)
        return json({ error: 'invalid_grant' }, 400);
      if (this.clientSecret) {
        const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
        if (auth !== expected) return json({ error: 'invalid_client' }, 401);
      }
      return json({ id_token: this.idToken(entry.login, entry.sub), token_type: 'Bearer' });
    }
    return json({ error: 'not_found' }, 404);
  };
}
