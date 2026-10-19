// OIDC sign-in on a real Hub against a local fake provider on 127.0.0.1 (FR-113, docs/13 §7):
// the owner configures it, links an identity, signs in with it (a session cookie at the
// callback), a member joins with an invitation and their identity, and a bad token sends the
// browser back to the sign-in page with the reason, never with a session.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOidc } from '../../../packages/core/test/fixtures/team/fake-oidc.ts';
import { OIDC_BINDING_COOKIE } from '../src/team.ts';
import { HOST, cookieOf, makeTeamHub, type TeamHub, type WireJson } from './team-env.ts';

let t: TeamHub;
let server: Server;
let idp: FakeOidc;
/** Who signs in at the provider's page next. */
let nextSub = 'alice';

beforeEach(async () => {
  server = createServer((req, res) => {
    const url = `${idp.issuer}${req.url ?? '/'}`;
    if (req.url?.startsWith('/authorize')) {
      // The user signs in at the provider, which sends the browser back to the Hub.
      const { state, code } = idp.approve(url, nextSub);
      const back = new URL(idp.logins.at(-1)!.redirectUri);
      back.searchParams.set('state', state);
      back.searchParams.set('code', code);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      void idp
        .fetch(url, {
          method: req.method ?? 'GET',
          headers,
          body: Buffer.concat(chunks).toString(),
        })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  idp = new FakeOidc({
    issuer: `http://127.0.0.1:${port}`,
    clientId: 'nova-hub',
    clientSecret: 'shh',
  });
  nextSub = 'alice';
  t = await makeTeamHub();
});

afterEach(async () => {
  await t.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = (r: { json(): unknown }) => r.json() as WireJson;

/** The browser: start at the Hub, sign in at the provider, come back to the callback. */
async function signIn(payload: Record<string, unknown>, headers: Record<string, string> = HOST) {
  const start = await t.hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/oidc/start',
    headers,
    payload,
  });
  if (start.statusCode !== 200) return { start, callback: null };
  // The browser keeps the binding cookie the start set; it goes back only to the callback.
  const binding = start.cookies.find((c) => c.name === OIDC_BINDING_COOKIE);
  expect(binding).toMatchObject({
    httpOnly: true,
    sameSite: 'Lax',
    path: '/api/v1/auth/oidc/callback',
    maxAge: 600,
  });
  const atProvider = await fetch(body(start).url as string, { redirect: 'manual' });
  const back = new URL(atProvider.headers.get('location')!);
  const callback = await t.hub.app.inject({
    method: 'GET',
    url: `${back.pathname}${back.search}`,
    headers: { ...HOST, cookie: `${OIDC_BINDING_COOKIE}=${binding!.value}` },
  });
  return { start, callback };
}

async function configure() {
  const r = await t.hub.app.inject({
    method: 'POST',
    url: '/api/v1/team/oidc',
    headers: t.owner.headers,
    payload: { label: 'Company', issuer: idp.issuer, clientId: 'nova-hub', clientSecret: 'shh' },
  });
  expect(r.statusCode).toBe(201);
  expect(r.body).not.toContain('shh');
  return body(r).id as string;
}

describe('OIDC sign-in on the Hub', () => {
  it('links the owner, then signs the owner in with a session cookie', async () => {
    const providerId = await configure();
    expect(
      body(
        await t.hub.app.inject({
          method: 'GET',
          url: '/api/v1/auth/oidc/providers',
          headers: HOST,
        }),
      ).items,
    ).toEqual([{ id: providerId, label: 'Company' }]);
    // Linking needs a session.
    expect((await signIn({ providerId, flow: 'link' })).start.statusCode).toBe(401);
    const linked = await signIn({ providerId, flow: 'link' }, t.owner.headers);
    expect(linked.callback?.statusCode).toBe(302);
    expect(linked.callback?.headers.location).toBe('/settings/account?oidc=linked');
    expect(cookieOf(linked.callback!)).toBeNull();
    const me = body(
      await t.hub.app.inject({ method: 'GET', url: '/api/v1/team/me', headers: t.owner.headers }),
    );
    expect(me.identities).toMatchObject([{ subject: 'alice', providerLabel: 'Company' }]);

    const signed = await signIn({ providerId, flow: 'sign_in' });
    expect(signed.callback?.headers.location).toBe('/');
    const session = cookieOf(signed.callback!);
    expect(session).toBeTruthy();
    const who = await t.hub.app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { ...HOST, authorization: `Bearer ${session!}` },
    });
    expect(body(who).accountId).toBe(t.owner.accountId);
  });

  it('lets a member join with an invitation and their identity', async () => {
    const providerId = await configure();
    const inv = body(
      await t.hub.app.inject({
        method: 'POST',
        url: '/api/v1/team/invitations',
        headers: t.owner.headers,
        payload: {},
      }),
    );
    const preview = await t.hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/join/preview',
      headers: HOST,
      payload: { token: inv.token },
    });
    expect(body(preview).providers).toEqual([{ id: providerId, label: 'Company' }]);
    nextSub = 'bob';
    const joined = await signIn({
      providerId,
      flow: 'join',
      invitation: inv.token,
      displayName: 'Bob',
    });
    expect(joined.callback?.headers.location).toBe('/');
    const session = cookieOf(joined.callback!)!;
    const me = body(
      await t.hub.app.inject({
        method: 'GET',
        url: '/api/v1/team/me',
        headers: { ...HOST, authorization: `Bearer ${session}` },
      }),
    );
    expect(me).toMatchObject({
      role: 'member',
      displayName: 'Bob',
      identities: [{ subject: 'bob' }],
    });
  });

  it('refuses a bad token or an unlinked identity with the reason and no session', async () => {
    const providerId = await configure();
    const unlinked = await signIn({ providerId, flow: 'sign_in' });
    expect(unlinked.callback?.headers.location).toBe('/sign-in?oidc_error=not_linked');
    expect(cookieOf(unlinked.callback!)).toBeNull();
    await signIn({ providerId, flow: 'link' }, t.owner.headers);
    for (const [override, reason] of [
      [{ aud: 'someone-else' }, 'oidc_audience'],
      [{ nonce: 'stolen' }, 'oidc_nonce'],
      [{ exp: Math.floor(Date.now() / 1000) - 3600 }, 'oidc_expired'],
      [{ iss: 'https://evil.test' }, 'oidc_issuer'],
    ] as const) {
      idp.override = override;
      const r = await signIn({ providerId, flow: 'sign_in' });
      expect([reason, r.callback?.headers.location]).toEqual([
        reason,
        `/sign-in?oidc_error=${reason}`,
      ]);
      expect(cookieOf(r.callback!)).toBeNull();
    }
    idp.override = {};
    idp.wrongKey = true;
    const forged = await signIn({ providerId, flow: 'sign_in' });
    expect(forged.callback?.headers.location).toBe('/sign-in?oidc_error=oidc_signature');
    // A callback without a state from this Hub.
    const stray = await t.hub.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/callback?state=x&code=y',
      headers: HOST,
    });
    expect(stray.headers.location).toBe('/sign-in?oidc_error=state_invalid');
  });

  it('lets only the owner configure providers; members cannot see the secret or the list', async () => {
    const providerId = await configure();
    const bea = await t.join('Bea');
    expect(
      (await t.hub.app.inject({ method: 'GET', url: '/api/v1/team/oidc', headers: bea.headers }))
        .statusCode,
    ).toBe(403);
    const list = await t.hub.app.inject({
      method: 'GET',
      url: '/api/v1/team/oidc',
      headers: t.owner.headers,
    });
    expect(body(list).items[0]).toMatchObject({ id: providerId, hasClientSecret: true });
    expect(list.body).not.toContain('shh');
    const patched = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/v1/team/oidc/${providerId}`,
      headers: t.owner.headers,
      payload: { enabled: false },
    });
    expect(body(patched).enabled).toBe(false);
    const off = await t.hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/start',
      headers: HOST,
      payload: { providerId },
    });
    expect(off.statusCode).toBe(404);
    expect(
      (
        await t.hub.app.inject({
          method: 'DELETE',
          url: `/api/v1/team/oidc/${providerId}`,
          headers: t.owner.headers,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('tests a provider from the Hub, also when it is off, under the same address rules', async () => {
    const providerId = await configure();
    const test = (id: string, headers = t.owner.headers) =>
      t.hub.app.inject({ method: 'POST', url: `/api/v1/team/oidc/${id}/test`, headers });
    const ok = await test(providerId);
    expect(body(ok)).toMatchObject({ ok: true });
    expect(body(ok).detail).toContain('1 signing key');
    await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/v1/team/oidc/${providerId}`,
      headers: t.owner.headers,
      payload: { enabled: false },
    });
    expect(body(await test(providerId)).ok).toBe(true);
    const bea = await t.join('Bea');
    expect((await test(providerId, bea.headers)).statusCode).toBe(403);
    expect((await test('nope')).statusCode).toBe(404);
    // A provider whose configuration points a sign-in at plain http elsewhere fails the test.
    const insecure = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: issuerOf(insecure),
          authorization_endpoint: 'http://idp.example.com/authorize',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
        }),
      );
    });
    await new Promise<void>((resolve) => insecure.listen(0, '127.0.0.1', resolve));
    try {
      const made = await t.hub.app.inject({
        method: 'POST',
        url: '/api/v1/team/oidc',
        headers: t.owner.headers,
        payload: { label: 'Bad', issuer: issuerOf(insecure), clientId: 'x' },
      });
      const bad = body(await test(body(made).id as string));
      expect(bad.ok).toBe(false);
      expect(bad.detail).toMatch(/https/);
    } finally {
      await new Promise<void>((resolve) => insecure.close(() => resolve()));
    }
    // Nothing answers: a clear failure, not an error.
    const gone = await t.hub.app.inject({
      method: 'POST',
      url: '/api/v1/team/oidc',
      headers: t.owner.headers,
      payload: { label: 'Gone', issuer: 'http://127.0.0.1:9', clientId: 'x' },
    });
    expect(body(await test(body(gone).id as string))).toMatchObject({ ok: false });
  });

  it('sends a failed link back to the account settings and a failed sign-in to the sign-in page', async () => {
    const providerId = await configure();
    idp.override = { nonce: 'from-another-login' };
    const link = await signIn({ providerId, flow: 'link' }, t.owner.headers);
    expect(link.callback?.headers.location).toBe('/settings/account?oidc_error=oidc_nonce');
    const signIn2 = await signIn({ providerId, flow: 'sign_in' });
    expect(signIn2.callback?.headers.location).toBe('/sign-in?oidc_error=oidc_nonce');
  });
});

function issuerOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
