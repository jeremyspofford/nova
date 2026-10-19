// OIDC sign-in (FR-113, docs/13 §7): ID tokens are accepted only with a good signature from the
// provider's key set, this issuer, this client as audience, an unexpired time and this sign-in's
// nonce; the flows link an identity, sign a linked person in, or let an invited member join; the
// state is used once and the client secret never leaves the vault.
import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  OidcError,
  OidcService,
  TeamService,
  discoverOidc,
  verifyIdToken,
  type AuditRecord,
} from '../src/index.ts';
import { FakeOidc, signJwt, type FakeAlg } from './fixtures/team/fake-oidc.ts';
import { ACCOUNT } from './helpers.ts';
import { ensureTeamTables } from './team-env.ts';

const NOW = new Date();

function claims(over: Record<string, unknown> = {}) {
  const now = Math.floor(NOW.getTime() / 1000);
  return {
    iss: 'https://idp.test',
    sub: 'u1',
    aud: 'nova-hub',
    exp: now + 60,
    iat: now,
    nonce: 'n1',
    ...over,
  };
}

describe('verifyIdToken', () => {
  const opts = (keys: JsonWebKey[]) => ({
    issuer: 'https://idp.test',
    clientId: 'nova-hub',
    nonce: 'n1',
    keys,
    now: NOW,
  });

  it.each(['RS256', 'ES256', 'EdDSA', 'PS256'] as FakeAlg[])('accepts a good %s token', (alg) => {
    const idp = new FakeOidc({ alg });
    const login = { state: 's', nonce: 'n1', challenge: '', redirectUri: '', clientId: 'nova-hub' };
    const token = idp.idToken(login, 'u1');
    expect(verifyIdToken(token, opts([idp.jwk()]))).toMatchObject({
      sub: 'u1',
      email: 'u1@idp.test',
    });
  });

  it('refuses each failing check with its reason', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k' };
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const good = (
      c: Record<string, unknown>,
      key = privateKey,
      h: Record<string, unknown> = { kid: 'k' },
    ) => signJwt('RS256', key, h, claims(c));
    const reason = (token: string, keys = [jwk]) => {
      try {
        verifyIdToken(token, opts(keys));
        return 'accepted';
      } catch (err) {
        return err instanceof OidcError ? err.reason : 'other';
      }
    };
    expect(reason(good({}))).toBe('accepted');
    expect(reason(good({}, other))).toBe('signature');
    expect(reason(good({ aud: 'someone-else' }))).toBe('audience');
    expect(reason(good({ aud: ['nova-hub', 'other'] }))).toBe('audience');
    expect(reason(good({ aud: ['nova-hub', 'other'], azp: 'nova-hub' }))).toBe('accepted');
    expect(reason(good({ azp: 'other' }))).toBe('audience');
    expect(reason(good({ iss: 'https://evil.test' }))).toBe('issuer');
    expect(reason(good({ exp: Math.floor(NOW.getTime() / 1000) - 120 }))).toBe('expired');
    expect(reason(good({ exp: 'soon' }))).toBe('expired');
    expect(reason(good({ iat: Math.floor(NOW.getTime() / 1000) + 600 }))).toBe('not_yet_valid');
    expect(reason(good({ nbf: Math.floor(NOW.getTime() / 1000) + 600 }))).toBe('not_yet_valid');
    expect(reason(good({ nonce: 'replayed' }))).toBe('nonce');
    expect(reason(good({ nonce: undefined }))).toBe('nonce');
    expect(reason(good({ sub: '' }))).toBe('subject');
    expect(reason(good({}, privateKey, { kid: 'unknown' }))).toBe('key');
    expect(reason(good({}), [])).toBe('key');
    expect(reason(signJwt('none', null, {}, claims()))).toBe('algorithm');
    expect(reason(signJwt('HS256', null, { kid: 'k' }, claims()))).toBe('algorithm');
    expect(reason(good({}, privateKey, { kid: 'k', crit: ['x'] }))).toBe('algorithm');
    expect(reason('not.a.jwt.at.all')).toBe('malformed');
    expect(reason('a.b')).toBe('malformed');
    expect(reason(`${good({}).split('.').slice(0, 2).join('.')}.!!`)).toBe('malformed');
    expect(reason('x'.repeat(20_000))).toBe('malformed');
    // A key for another algorithm is not used.
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(reason(good({}), [{ ...ec.publicKey.export({ format: 'jwk' }), kid: 'k' }])).toBe('key');
  });

  it('reads the provider configuration and refuses a mismatched or insecure one', async () => {
    const idp = new FakeOidc();
    await expect(discoverOidc('https://idp.test', idp.fetch)).resolves.toMatchObject({
      jwks_uri: 'https://idp.test/jwks',
    });
    const lying = (url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: url.includes('a.test') ? 'https://b.test' : 'https://c.test',
            authorization_endpoint: 'http://c.test/a',
            token_endpoint: 'https://c.test/t',
            jwks_uri: 'https://c.test/k',
          }),
        ),
      );
    await expect(discoverOidc('https://a.test', lying)).rejects.toMatchObject({
      reason: 'discovery',
    });
    await expect(discoverOidc('https://c.test', lying)).rejects.toMatchObject({
      reason: 'discovery',
    });
    const down = () => Promise.resolve(new Response('no', { status: 500 }));
    await expect(discoverOidc('https://c.test', down)).rejects.toMatchObject({
      reason: 'discovery',
    });
  });
});

describe('OIDC flows', () => {
  let db: NovaDatabase;
  let idp: FakeOidc;
  let team: TeamService;
  let oidc: OidcService;
  let secrets: MemorySecretStore;
  const audit: AuditRecord[] = [];
  const sessions: string[] = [];

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    ensureTeamTables(db);
    const at = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(ACCOUNT, at, at);
    idp = new FakeOidc();
    secrets = new MemorySecretStore();
    audit.length = 0;
    sessions.length = 0;
    const events = new MemoryEventSink();
    team = new TeamService({
      db,
      events,
      sessions: {
        issue: (accountId) => {
          sessions.push(accountId);
          return Promise.resolve({ token: `s-${sessions.length}`, maxAgeS: 60 });
        },
        revokeAll: () => Promise.resolve(0),
      },
    });
    oidc = new OidcService({
      db,
      secrets,
      events,
      team,
      fetch: idp.fetch,
      audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    });
  });

  afterEach(() => db.close());

  /** The browser that starts holds the binding cookie; the callback must come from it. */
  const BINDING = 'b'.repeat(43);
  const start = (input: Omit<Parameters<OidcService['start']>[0], 'browserBinding' | 'address'>) =>
    oidc.start({ ...input, browserBinding: BINDING, address: '127.0.0.1' });
  const cb = (q: Parameters<OidcService['callback']>[0]) => oidc.callback(q, BINDING);

  const provider = () =>
    oidc.createProvider(ACCOUNT, {
      label: 'Company login',
      issuer: 'https://idp.test',
      clientId: 'nova-hub',
      clientSecret: 'shh',
    });

  it('keeps the client secret in the vault and only the owner configures providers', async () => {
    const p = await provider();
    expect(p).toMatchObject({ hasClientSecret: true, scopes: ['openid', 'profile', 'email'] });
    expect(JSON.stringify(p)).not.toContain('shh');
    const row = db.raw.prepare('SELECT * FROM oidc_provider').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('shh');
    expect(await secrets.get(String(row.client_secret_ref))).toBe('shh');
    await expect(provider()).rejects.toMatchObject({ code: 'conflict' });
    const inv = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    const member = (await team.redeem(inv.token, 'Bea')).accountId;
    expect(() => oidc.providers(member)).toThrow(/only the owner/);
    await expect(oidc.updateProvider(member, p.id, { enabled: false })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const off = await oidc.updateProvider(ACCOUNT, p.id, { clientSecret: null, enabled: false });
    expect(off).toMatchObject({ hasClientSecret: false, enabled: false });
    expect(await secrets.list()).toEqual([]);
    expect(oidc.publicProviders()).toEqual([]);
    await oidc.deleteProvider(ACCOUNT, p.id);
    expect(oidc.providers(ACCOUNT)).toEqual([]);
    expect(audit.map((a) => a.action)).toEqual([
      'oidc.provider.create',
      'oidc.provider.update',
      'oidc.provider.delete',
    ]);
    expect(JSON.stringify(audit)).not.toContain('shh');
  });

  it('links an identity, then signs that person in with PKCE and the client secret', async () => {
    const p = await provider();
    await expect(
      start({ providerId: p.id, flow: 'link', baseUrl: 'http://hub' }),
    ).rejects.toMatchObject({ code: 'token_required' });
    // Not linked yet: a sign-in is refused.
    let s = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    await expect(cb(idp.approve(s.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'not_linked' },
    });
    s = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    const back = idp.approve(s.url, 'alice');
    expect(idp.logins.at(-1)).toMatchObject({
      redirectUri: 'http://hub/api/v1/auth/oidc/callback',
    });
    await expect(cb(back)).resolves.toEqual({ kind: 'linked', accountId: ACCOUNT });
    // The state is used once.
    await expect(cb(back)).rejects.toMatchObject({
      details: { reason: 'state_invalid' },
    });
    expect(oidc.identities(ACCOUNT)).toMatchObject([{ subject: 'alice', email: 'alice@idp.test' }]);
    s = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    const out = await cb(idp.approve(s.url, 'alice'));
    expect(out).toMatchObject({ kind: 'signed_in', accountId: ACCOUNT });
    expect(sessions).toEqual([ACCOUNT]);
    const sent = idp.tokenRequests.at(-1)!;
    expect(sent.auth).toMatch(/^Basic /);
    expect(sent.body.get('code_verifier')).toBeTruthy();
    expect(oidc.identities(ACCOUNT)[0]!.lastSignInAt).not.toBeNull();
  });

  it('refuses a bad token, a provider error and an unknown state at the callback', async () => {
    const p = await provider();
    const s1 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    idp.override = { aud: 'another-client' };
    await expect(cb(idp.approve(s1.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'oidc_audience' },
    });
    idp.override = {};
    idp.wrongKey = true;
    const s2 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    await expect(cb(idp.approve(s2.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'oidc_signature' },
    });
    idp.wrongKey = false;
    idp.override = { exp: Math.floor(Date.now() / 1000) - 3600 };
    const s3 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    await expect(cb(idp.approve(s3.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'oidc_expired' },
    });
    idp.override = { nonce: 'from-another-login' };
    const s4 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    await expect(cb(idp.approve(s4.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'oidc_nonce' },
    });
    idp.override = {};
    const s5 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    const { state } = idp.approve(s5.url, 'alice');
    await expect(cb({ state, error: 'access_denied' })).rejects.toMatchObject({
      details: { reason: 'provider_error' },
    });
    await expect(cb({ state: 'never-issued', code: 'x' })).rejects.toMatchObject({
      details: { reason: 'state_invalid' },
    });
    // A wrong code (the PKCE verifier and code do not match) fails the exchange.
    const s6 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    const back = idp.approve(s6.url, 'alice');
    await expect(cb({ state: back.state, code: 'forged' })).rejects.toMatchObject({
      details: { reason: 'oidc_token_exchange' },
    });
    expect(oidc.identities(ACCOUNT)).toEqual([]);
    expect(audit.filter((a) => a.action === 'oidc.refused')).toHaveLength(5);
  });

  it('reads the key set again when the provider rotated its key', async () => {
    const p = await provider();
    const s1 = await start({
      providerId: p.id,
      flow: 'link',
      baseUrl: 'http://hub',
      accountId: ACCOUNT,
    });
    await cb(idp.approve(s1.url, 'alice'));
    expect(idp.jwksFetches).toBe(1);
    idp.rotate('key-2');
    const s2 = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    // A token signed with a key the cached set does not know: the set is read again.
    await expect(cb(idp.approve(s2.url, 'alice'))).resolves.toMatchObject({
      kind: 'signed_in',
    });
    expect(idp.jwksFetches).toBe(2);
    // The same kid with another key is a bad signature, not a rotation.
    idp.wrongKey = true;
    const s3 = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    await expect(cb(idp.approve(s3.url, 'alice'))).rejects.toMatchObject({
      details: { reason: 'oidc_signature' },
    });
  });

  it('lets an invited member join with their identity, once', async () => {
    const p = await provider();
    const inv = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    await expect(
      start({
        providerId: p.id,
        flow: 'join',
        baseUrl: 'http://hub',
        invitation: 'nvi_wrong',
      }),
    ).rejects.toMatchObject({ details: { reason: 'invitation_invalid' } });
    const s = await start({
      providerId: p.id,
      flow: 'join',
      baseUrl: 'http://hub',
      invitation: inv.token,
    });
    const out = await cb(idp.approve(s.url, 'bob'));
    expect(out.kind).toBe('joined');
    expect(team.roleOf(out.accountId)).toBe('member');
    expect(team.person(out.accountId)?.displayName).toBe('User bob');
    expect(oidc.identities(out.accountId)).toMatchObject([{ subject: 'bob' }]);
    // The invitation is used, and the identity is taken.
    expect(team.invitationUsable(inv.token)).toBe(false);
    const inv2 = await team.createInvitation(ACCOUNT, {}, 'http://hub');
    const s2 = await start({
      providerId: p.id,
      flow: 'join',
      baseUrl: 'http://hub',
      invitation: inv2.token,
    });
    await expect(cb(idp.approve(s2.url, 'bob'))).rejects.toMatchObject({
      details: { reason: 'identity_taken' },
    });
    expect(team.invitationUsable(inv2.token)).toBe(true);
    // Bob signs in later with the same identity; unlinking ends that.
    const s3 = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    await expect(cb(idp.approve(s3.url, 'bob'))).resolves.toMatchObject({
      kind: 'signed_in',
      accountId: out.accountId,
    });
    await oidc.unlink(out.accountId, oidc.identities(out.accountId)[0]!.id);
    await expect(oidc.unlink(out.accountId, 'gone')).rejects.toMatchObject({ code: 'not_found' });
    // A removed member cannot sign in.
    await team.removeMember(ACCOUNT, out.accountId);
    const s4 = await start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' });
    await expect(cb(idp.approve(s4.url, 'bob'))).rejects.toMatchObject({
      details: { reason: 'not_linked' },
    });
  });

  it('refuses a disabled or unknown provider and an unreachable one', async () => {
    const p = await provider();
    await oidc.updateProvider(ACCOUNT, p.id, { enabled: false });
    await expect(
      start({ providerId: p.id, flow: 'sign_in', baseUrl: 'http://hub' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const broken = new OidcService({
      db,
      secrets,
      events: new MemoryEventSink(),
      team,
      fetch: () => Promise.reject(new Error('offline')),
    });
    const q = await broken.createProvider(ACCOUNT, {
      label: 'Down',
      issuer: 'https://down.test',
      clientId: 'x',
    });
    await expect(
      broken.start({
        browserBinding: BINDING,
        address: '127.0.0.1',
        providerId: q.id,
        flow: 'sign_in',
        baseUrl: 'http://hub',
      }),
    ).rejects.toMatchObject({ code: 'node_unavailable' });
  });
});
