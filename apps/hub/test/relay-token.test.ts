// A Hub registering with a private Relay (M6.5 known gap; FR-137, docs/22 §3): the Relay service
// requires a registration token (NOVA_RELAY_REGISTRATION_TOKEN); the owner stores it with
// `PUT /api/v1/relay/registration-token` (into the vault, never answered back), the setting names
// the vault entry, and the connector sends it when it registers, and only then.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RELAY_REGISTRATION_TOKEN_REF,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  type RelayConfigView,
} from '@nova/shared';
import { relayRegistrationSecret, relayRegistrationTokenFor } from '@nova/core';
import type { NovaDatabase } from '@nova/storage';
import type { RelayServer } from '@nova/relay-service';
import { setupRelay, type RelayArea } from '../src/relay.ts';
import {
  ACCOUNT,
  areaCtx,
  relayDb,
  startRelay,
  until,
  type AreaCtx,
  type WireJson,
} from './relay-env.ts';

const AUTH = { 'x-account': ACCOUNT };
const TOKEN = 'relay-registration-token-0123456789';

let db: NovaDatabase;
let env: AreaCtx;
let app: FastifyInstance;
let area: RelayArea;
let relay: RelayServer;
let relayUrl: string;
let seen: string[];

beforeEach(async () => {
  db = await relayDb();
  env = areaCtx(db);
  ({ relay, url: relayUrl } = await startRelay({ registrationToken: TOKEN }));
  seen = [];
  area = await setupRelay(env.ctx, {
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
    // What the connector sends the Relay over HTTP (the token travels only with registration).
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(
        `${init?.method ?? 'GET'} ${new URL(url).pathname} ${headers.get('authorization') ?? '-'}`,
      );
      return globalThis.fetch(input, init);
    },
  });
  app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  await relay.close();
  db.close();
});

const api = async (
  method: 'GET' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
  headers = AUTH,
) => {
  const r = await app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, json: r.json<WireJson>(), body: r.body };
};

describe('the Relay registration token', () => {
  it('registers with a private Relay once the owner stores its token', async () => {
    // Without the token the Relay refuses the Hub, and the status says why.
    expect((await api('PATCH', '/api/v1/relay', { enabled: true, url: relayUrl })).status).toBe(
      200,
    );
    await until(() => area.status().state === 'error');
    expect(area.status().detail).toMatch(/needs a registration token/);
    // A wrong token is refused as such.
    expect(
      (await api('PUT', '/api/v1/relay/registration-token', { token: 'not-the-token' })).status,
    ).toBe(200);
    await until(() => /refused the registration token/.test(area.status().detail ?? ''));
    // The right one: the Hub registers and connects.
    const put = await api('PUT', '/api/v1/relay/registration-token', { token: TOKEN });
    expect(put.status).toBe(200);
    expect(put.json.registrationToken).toBe(true);
    expect(put.body).not.toContain(TOKEN);
    await until(() => area.status().state === 'connected');
    // Stored with the Relay it is for.
    expect(JSON.parse((await env.secrets.get(RELAY_REGISTRATION_TOKEN_REF))!)).toEqual({
      v: 1,
      url: relayUrl,
      token: TOKEN,
    });
    expect(await env.ctx.setting('relay.registrationTokenRef')).toBe(RELAY_REGISTRATION_TOKEN_REF);
    // The token went with the registration only, never with the connection or anything else.
    const registrations = seen.filter((s) => s.startsWith('POST /v1/relay/hubs'));
    expect(registrations.at(-1)).toBe(`POST /v1/relay/hubs Bearer ${TOKEN}`);
    expect(seen.filter((s) => s.includes(TOKEN) && !s.startsWith('POST /v1/relay/hubs'))).toEqual(
      [],
    );
    const view = await api('GET', '/api/v1/relay');
    expect(view.json.registrationToken).toBe(true);
    expect(view.body).not.toContain(TOKEN);
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['relay.registrationToken.set']),
    );
    expect(JSON.stringify(env.audit)).not.toContain(TOKEN);
  });

  it('removes the token, needs a session, and validates', async () => {
    // A token belongs to a Relay: none can be set before the Relay URL is.
    const early = await api('PUT', '/api/v1/relay/registration-token', { token: TOKEN });
    expect([early.status, early.json.error?.details?.reason]).toEqual([409, 'relay_url_missing']);
    expect((await api('PATCH', '/api/v1/relay', { url: relayUrl })).status).toBe(200);
    await api('PUT', '/api/v1/relay/registration-token', { token: TOKEN });
    const cleared = await api('PUT', '/api/v1/relay/registration-token', { token: null });
    expect(cleared.json.registrationToken).toBe(false);
    // GET and PATCH answer RelayConfigView, which says so too (M7).
    const patched = (await api('PATCH', '/api/v1/relay', {})).json as RelayConfigView;
    expect(patched.registrationToken).toBe(false);
    expect(await env.secrets.get(RELAY_REGISTRATION_TOKEN_REF)).toBeNull();
    expect(await env.ctx.setting('relay.registrationTokenRef')).toBe('');
    expect(env.audit.map((a) => a.action)).toContain('relay.registrationToken.clear');
    expect(
      (await api('PUT', '/api/v1/relay/registration-token', { token: TOKEN }, {} as typeof AUTH))
        .status,
    ).toBe(401);
    for (const bad of [
      {},
      { token: 'short' },
      { token: 'has space in it' },
      { token: TOKEN, x: 1 },
    ])
      expect((await api('PUT', '/api/v1/relay/registration-token', bad)).status).toBe(400);
    // The setting can name only a registration token, never another vault entry.
    const schema = SETTINGS['relay.registrationTokenRef'].schema;
    expect(schema.safeParse('secret://hub/identity').success).toBe(false);
    expect(schema.safeParse('secret://relay/abc/route-token').success).toBe(false);
    expect(schema.safeParse('secret://relay/registration/other').success).toBe(true);
    expect(schema.safeParse('').success).toBe(true);
  });

  it('never sends the token to another Relay', async () => {
    expect((await api('PATCH', '/api/v1/relay', { enabled: true, url: relayUrl })).status).toBe(
      200,
    );
    expect((await api('PUT', '/api/v1/relay/registration-token', { token: TOKEN })).status).toBe(
      200,
    );
    await until(() => area.status().state === 'connected');
    // The owner moves the Hub to another Relay (an open one, then one with its own token).
    const open = await startRelay();
    const closed = await startRelay({ registrationToken: 'another-relays-token-123456' });
    try {
      expect((await api('PATCH', '/api/v1/relay', { url: open.url })).status).toBe(200);
      await until(() => area.status().state === 'connected' && area.status().url === open.url);
      expect((await api('PATCH', '/api/v1/relay', { url: closed.url })).status).toBe(200);
      await until(() => area.status().state === 'error' && area.status().url === closed.url);
      expect(area.status().detail).toContain(`the registration token was set for ${relayUrl}`);
      const toOthers = seen.filter(
        (r) => r.startsWith('POST /v1/relay/hubs') && r.endsWith(`Bearer ${TOKEN}`),
      );
      expect(toOthers).toHaveLength(1); // only the registration with the Relay it was set for
      // Every other registration (the first try, the other two Relays) carried no token at all.
      const rest = seen.filter((r) => r.startsWith('POST /v1/relay/hubs') && !r.endsWith(TOKEN));
      expect(rest.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rest)).toEqual(new Set(['POST /v1/relay/hubs -']));
    } finally {
      await open.relay.close();
      await closed.relay.close();
    }
    // A bare token in the vault (tied to no Relay) is never sent at all.
    expect(relayRegistrationTokenFor(TOKEN, relayUrl)).toEqual({ token: null, setFor: null });
    expect(
      relayRegistrationTokenFor(relayRegistrationSecret(TOKEN, `${relayUrl}/`), relayUrl),
    ).toEqual({ token: TOKEN });
    expect(relayRegistrationTokenFor('{"url":1}', relayUrl)).toEqual({ token: null, setFor: null });
  });

  it('says so when the vault lost the token the setting names', async () => {
    db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES ('relay.registrationTokenRef', 'global', '', ?, ?)",
      )
      .run(JSON.stringify(RELAY_REGISTRATION_TOKEN_REF), new Date().toISOString());
    expect((await api('PATCH', '/api/v1/relay', { enabled: true, url: relayUrl })).status).toBe(
      200,
    );
    await until(() => area.status().state === 'error');
    expect(area.status().detail).toMatch(/missing from the vault/);
    expect(seen.filter((s) => s.startsWith('POST /v1/relay/hubs'))).toEqual([]);
  });
});
