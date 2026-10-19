// The Hub's Relay connector (FR-137, docs/22 §3, ADR-094) against a real Relay service on
// loopback: registration, the status and its events, pairing with the real Add Device service's
// seam shape (claims, refusals, approval, denial), the tunnel with a dispatcher, stale-stream
// notices, revocation (local, by device, and while the Relay is unreachable), reconciliation on
// reconnect, the reachability test and the endpoint source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import {
  RelayClient,
  generateEd25519,
  pairWithRelay,
  utf8,
  type PairWithRelayResult,
} from '@nova/relay';
import { buildRelayServer, type RelayServer } from '../../../services/relay/src/index.ts';
import {
  MemoryEventSink,
  RelayHub,
  pairingCodeHash,
  type AuditRecord,
  type RelayHubOptions,
  type RelayPairingSeam,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
const ITER = 500;

class Seam implements RelayPairingSeam {
  claims: Parameters<RelayPairingSeam['requestFromRelay']>[0][] = [];
  listeners = new Set<Parameters<RelayPairingSeam['onDecided']>[0]>();
  fail: string | null = null;
  revokedKeys = new Set<string>();
  isKeyRevoked(publicKey: string) {
    return Promise.resolve(this.revokedKeys.has(publicKey));
  }
  requestFromRelay(claim: Parameters<RelayPairingSeam['requestFromRelay']>[0]) {
    if (this.fail) return Promise.reject(new Error(this.fail));
    this.claims.push(claim);
    return Promise.resolve({ requestId: `req-${this.claims.length}`, confirmation: '123456' });
  }
  onDecided(fn: Parameters<RelayPairingSeam['onDecided']>[0]) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async decide(i: number, decision: 'approved' | 'denied' | 'expired', deviceId: string | null) {
    for (const fn of this.listeners)
      await fn({
        accountId: ACCOUNT,
        requestId: `req-${i + 1}`,
        decision,
        deviceId,
        relayClientId: this.claims[i]!.relayClientId,
      });
  }
}

let db: NovaDatabase;
let relay: RelayServer;
let url: string;
let hub: RelayHub;
let events: MemoryEventSink;
let audit: AuditRecord[];
let logs: MemorySink;
let seam: Seam;
let settings: { enabled: boolean; url: string };
let secrets: MemorySecretStore;
let fetchHook: ((u: string, init?: RequestInit) => Promise<Response> | null) | null;
const clients: RelayClient[] = [];

async function until<T>(
  fn: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  ms = 8_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function makeHub(over: Partial<RelayHubOptions> = {}): RelayHub {
  const h = new RelayHub({
    db,
    secrets,
    events,
    log: new Logger({ module: 'relay', sinks: [logs] }),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    settings: () => Promise.resolve(settings),
    fetch: (u, init) =>
      fetchHook?.(u instanceof Request ? u.url : u.toString(), init) ?? fetch(u, init),
    backoff: { initialMs: 40, maxMs: 150, jitter: 0 },
    retransmitMs: 200,
    kdfIterations: ITER,
    decidedGraceMs: 100,
    ...over,
  });
  seam = new Seam();
  h.usePairing(seam);
  return h;
}

async function startRelayService(port = 0, dataDir: string | null = null) {
  relay = await buildRelayServer({ log: new Logger({ module: 'relay', sinks: [] }), dataDir });
  url = await relay.app.listen({ host: '127.0.0.1', port });
}

async function pair(
  code = 'ABCD-EFGH',
  device?: Awaited<ReturnType<typeof generateEd25519>>,
): Promise<PairWithRelayResult> {
  const slot = await hub.openPairing({
    accountId: ACCOUNT,
    pairingId: `add-${seam.claims.length + 1}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    code,
  });
  return pairWithRelay({
    relayUrl: slot.relayUrl,
    relayPairingId: slot.relayPairingId,
    code,
    device: device ?? (await generateEd25519()),
    name: 'Phone',
    platform: 'android',
    kind: 'native',
    kdfIterations: ITER,
  });
}

function start(paired: PairWithRelayResult['paired']): RelayClient {
  const c = new RelayClient({
    paired,
    backoff: { initialMs: 40, maxMs: 150, jitter: 0 },
    retransmitMs: 200,
    requestTimeoutMs: 5_000,
  });
  clients.push(c);
  c.start();
  return c;
}

const rows = () =>
  db.raw
    .prepare(
      'SELECT id, status, device_id, request_id FROM relay_client ORDER BY created_at, rowid',
    )
    .all() as {
    id: string;
    status: string;
    device_id: string | null;
    request_id: string | null;
  }[];

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  events = new MemoryEventSink();
  audit = [];
  logs = new MemorySink();
  fetchHook = null;
  secrets = new MemorySecretStore();
  await startRelayService();
  settings = { enabled: true, url };
  hub = makeHub();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await hub.stop();
  await relay.close();
  db.close();
});

describe('RelayHub', () => {
  it('stays off until enabled and configured, then registers and connects', async () => {
    settings = { enabled: false, url: '' };
    await hub.start();
    expect(hub.status().state).toBe('disabled');
    settings = { enabled: true, url: '' };
    await hub.reconfigure();
    expect(hub.status()).toMatchObject({ state: 'unconfigured', detail: 'set the Relay URL' });
    expect(await hub.endpointSource().list()).toEqual([]);
    settings = { enabled: true, url };
    await hub.reconfigure();
    await until(() => hub.status().state === 'connected');
    expect(
      events.names().filter((n) => n === 'relay.status.changed').length,
    ).toBeGreaterThanOrEqual(4);
    const [ep] = await hub.endpointSource().list();
    expect(ep).toMatchObject({ transport: 'relay', url, health: 'ok', priority: 3 });
    expect(await hub.test()).toMatchObject({ ok: true, reachable: true, state: 'connected' });
    // Applying the same settings again changes nothing.
    await hub.reconfigure();
    expect(relay.state.hubs.size).toBe(1);
  });

  it('reports a failed registration and an unreachable Relay', async () => {
    fetchHook = (u) =>
      u.endsWith('/v1/relay/hubs') ? Promise.resolve(new Response('{}', { status: 503 })) : null;
    await hub.start();
    expect(hub.status()).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('answered 503'),
    });
    settings = { enabled: true, url: 'http://127.0.0.1:9' };
    expect(await hub.test()).toMatchObject({ ok: false, reachable: false });
    fetchHook = (u) =>
      u.endsWith('/health') ? Promise.resolve(new Response('{}', { status: 500 })) : null;
    expect(await hub.test()).toMatchObject({
      ok: false,
      reachable: false,
      detail: 'the Relay answered 500',
    });
    settings = { enabled: true, url: '' };
    expect(await hub.test()).toMatchObject({ ok: false, detail: 'no Relay URL is set' });
  });

  it('refuses pairing slots without a Relay, or when the Relay refuses', async () => {
    settings = { enabled: false, url: '' };
    await hub.start();
    const input = {
      accountId: ACCOUNT,
      pairingId: 'add-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      code: 'ABCD-EFGH',
    };
    await expect(hub.openPairing(input)).rejects.toMatchObject({ code: 'capability_missing' });
    settings = { enabled: true, url };
    await hub.reconfigure();
    await expect(
      hub.openPairing({ ...input, expiresAt: new Date(0).toISOString() }),
    ).rejects.toMatchObject({
      code: 'node_unavailable',
    });
  });

  it('pairs, tunnels requests to the dispatcher with the client identity, and notices stale streams', async () => {
    const seen: { path: string; client: unknown; auth: string | undefined }[] = [];
    hub.useDispatch((req) => {
      seen.push({ path: req.path, client: req.client, auth: req.headers.authorization });
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: [utf8('hi')],
      });
    });
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    await until(() => seam.claims.length === 1);
    expect(seam.claims[0]).toMatchObject({
      pairingId: 'add-1',
      codeHashCheck: pairingCodeHash('add-1', 'ABCD-EFGH'),
      kind: 'native',
      relayClientId: out.paired.clientId,
    });
    expect(rows()).toEqual([
      { id: out.paired.clientId, status: 'pending', device_id: null, request_id: 'req-1' },
    ]);
    const c = start(out.paired);
    await seam.decide(0, 'approved', 'dev-1');
    expect(await c.waitForPaired()).toEqual({ requestId: 'req-1', deviceId: 'dev-1' });
    expect(events.names()).toContain('relay.client.paired');
    const res = await c.fetch('/api/v1/x', { headers: { authorization: 'Bearer t' } });
    expect(await res.text()).toBe('hi');
    expect(seen).toEqual([
      {
        path: '/api/v1/x',
        client: { id: out.paired.clientId, accountId: ACCOUNT, deviceId: 'dev-1' },
        auth: 'Bearer t',
      },
    ]);
    expect(hub.listClients(ACCOUNT)[0]).toMatchObject({
      status: 'active',
      deviceId: 'dev-1',
      relayUrl: url,
    });
    // The stream floor is stored, so a restarted Hub still refuses streams it already served.
    const floor = (
      db.raw.prepare('SELECT stream_floor FROM relay_client').get() as { stream_floor: number }
    ).stream_floor;
    expect(floor).toBeGreaterThan(0);
    // A Hub restart: the same registration, the client continues on new streams.
    await hub.stop();
    hub = makeHub();
    hub.useDispatch(() => Promise.resolve({ status: 200, headers: {}, body: [utf8('again')] }));
    await hub.start();
    await until(() => hub.status().state === 'connected');
    expect(await (await c.fetch('/api/v1/y')).text()).toBe('again');
    expect(relay.state.hubs.size).toBe(1);
  });

  it('answers 503 through the tunnel until a dispatcher is set', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    const c = start(out.paired);
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'approved', null);
    await c.waitForPaired();
    const res = await c.fetch('/api/v1/x');
    expect(res.status).toBe(503);
  });

  it('refuses claims Add Device refuses, a missing seam, and bad claims', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    seam.fail = 'expired';
    const out = await pair();
    await until(() => rows()[0]?.status === 'denied');
    await until(() => !relay.state.routes.has(out.paired.clientRoute));
    // A claim for a slot this connector did not open is dropped and logged.
    const slot = await hub.openPairing({
      accountId: ACCOUNT,
      pairingId: 'add-x',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      code: 'ABCD-EFGH',
    });
    // The wrong code cannot even claim at the Relay.
    await expect(
      pairWithRelay({
        relayUrl: url,
        relayPairingId: slot.relayPairingId,
        code: 'WXYZ-2345',
        device: await generateEd25519(),
        name: 'x',
        platform: 'y',
        kdfIterations: ITER,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('denies, revokes and cascades', async () => {
    const cascade: string[] = [];
    hub.onClientRevoked((_a, d) => {
      cascade.push(d);
    });
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const denied = await pair();
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'denied', null);
    expect(rows()[0]!.status).toBe('denied');
    expect(audit.at(-1)).toMatchObject({
      action: 'relay.pair',
      decision: 'denied',
      kind: 'network',
    });
    void denied;
    const device = await generateEd25519();
    const out = await pair('QRST-VWXY', device);
    await until(() => seam.claims.length === 2);
    const c = start(out.paired);
    await seam.decide(1, 'approved', 'dev-2');
    await c.waitForPaired();
    await expect(hub.revokeClient(ACCOUNT, 'missing')).rejects.toMatchObject({ code: 'not_found' });
    const view = await hub.revokeClient(ACCOUNT, out.paired.clientId);
    expect(view.status).toBe('revoked');
    expect(cascade).toEqual(['dev-2']);
    await until(() => c.state === 'revoked');
    // The same key is refused next time.
    const again = await pair('MNPQ-RSTV', device);
    await until(() => !relay.state.routes.has(again.paired.clientRoute));
    expect(seam.claims).toHaveLength(2);
    // revokeDevice on an already revoked device is a no-op.
    await hub.revokeDevice(ACCOUNT, 'dev-2');
    expect(audit.filter((a) => a.action === 'relay.revoke')).toHaveLength(1);
  });

  it('tells a pending client it was denied or expired, then drops its route (M7)', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const first = await pair();
    await until(() => seam.claims.length === 1);
    const c1 = start(first.paired);
    await until(() => c1.state === 'open');
    await seam.decide(0, 'denied', null);
    expect(await c1.waitForDecision()).toEqual({ decision: 'denied', requestId: 'req-1' });
    // The route goes after the grace, and the client sees it revoked.
    await until(() => !relay.state.routes.has(first.paired.clientRoute));
    await until(() => c1.state === 'revoked');
    const second = await pair('JKMN-PQRS');
    await until(() => seam.claims.length === 2);
    const c2 = start(second.paired);
    await until(() => c2.state === 'open');
    await seam.decide(1, 'expired', null);
    expect(await c2.waitForDecision()).toEqual({ decision: 'expired', requestId: 'req-2' });
    await until(() => !relay.state.routes.has(second.paired.clientRoute));
    expect(rows().map((r) => r.status)).toEqual(['denied', 'expired']);
  });

  it('tells a refused claim it was denied, and deletes declined routes when it stops', async () => {
    await hub.stop();
    // A grace long enough for a client that connects right after its claim.
    hub = makeHub({ decidedGraceMs: 60_000 });
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const revoked = await generateEd25519();
    seam.revokedKeys.add(revoked.publicKey);
    const out = await pair('QRST-2345', revoked);
    const c = start(out.paired);
    expect(await c.waitForDecision()).toEqual({ decision: 'denied', requestId: null });
    expect(seam.claims).toHaveLength(0);
    // Still in its grace: stopping deletes it at once.
    expect(relay.state.routes.has(out.paired.clientRoute)).toBe(true);
    await hub.stop();
    expect(relay.state.routes.has(out.paired.clientRoute)).toBe(false);
  });

  it('tells the Relay what it missed when it reconnects', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    const c = start(out.paired);
    await until(() => seam.claims.length === 1);
    // The Relay cannot be reached for the confirmation: the client stays pending there.
    fetchHook = (u) => (u.includes('/confirm') ? Promise.reject(new Error('down')) : null);
    await seam.decide(0, 'approved', 'dev-1');
    expect(rows()[0]!.status).toBe('active');
    expect(relay.state.routes.get(out.paired.clientRoute)?.status).toBe('pending');
    fetchHook = null;
    settings = { enabled: false, url };
    await hub.reconfigure();
    settings = { enabled: true, url };
    await hub.reconfigure();
    await until(() => relay.state.routes.get(out.paired.clientRoute)?.status === 'active');
    void c;
  });

  it('registers again by itself when a Relay forgets a Hub without clients', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const port = Number(new URL(url).port);
    await relay.close();
    await startRelayService(port);
    await until(() => relay.state.hubs.size === 1 && hub.status().state === 'connected');
    expect(
      db.raw.prepare('SELECT status FROM relay_registration ORDER BY created_at').all(),
    ).toEqual([{ status: 'rejected' }, { status: 'active' }]);
  });

  it('asks the owner when a Relay forgets a Hub with clients, and cleans the vault on re-registering', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    await pair();
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'approved', 'dev-1');
    const first = db.raw
      .prepare('SELECT token_ref, x25519_key_ref FROM relay_registration')
      .get() as {
      token_ref: string;
      x25519_key_ref: string;
    };
    const port = Number(new URL(url).port);
    await relay.close();
    await startRelayService(port);
    await until(() => hub.status().state === 'error');
    expect(hub.status().detail).toContain('no longer knows this Hub');
    expect(
      (db.raw.prepare('SELECT status FROM relay_registration').get() as { status: string }).status,
    ).toBe('rejected');
    // The same settings again register anew; the old token and key leave the vault.
    await hub.reconfigure();
    await until(() => hub.status().state === 'connected');
    expect(await secrets.has(first.token_ref)).toBe(false);
    expect(await secrets.has(first.x25519_key_ref)).toBe(false);
  });

  it('logs envelopes from unknown clients once per minute', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    await until(() => seam.claims.length === 1);
    // Forget the client locally while the Relay still routes it.
    await seam.decide(0, 'approved', null);
    db.raw.prepare('DELETE FROM relay_client').run();
    await hub.reconfigure();
    settings = { enabled: false, url };
    await hub.reconfigure();
    settings = { enabled: true, url };
    await hub.reconfigure();
    await until(() => hub.status().state === 'connected');
    const c = start(out.paired);
    const p = c.fetch('/api/v1/x');
    p.catch(() => undefined);
    await until(() => logs.records.some((r) => r.reason === 'unknown_client'));
    expect(logs.records.filter((r) => r.reason === 'unknown_client')).toHaveLength(1);
  });

  it('never lets a claim touch an existing client (a Relay naming its id)', async () => {
    // The "malicious Relay": rewrite the client id on forwarded claims (the review's probe).
    let rewrite: string | null = null;
    hub = makeHub({
      webSocket: (u, protocols) => {
        const real = new WebSocket(u, protocols);
        const w = {
          get readyState() {
            return real.readyState;
          },
          send: (d: string) => real.send(d),
          close: (c?: number, why?: string) => real.close(c, why),
          onopen: null as ((ev: unknown) => void) | null,
          onclose: null as ((ev: { code: number; reason: string }) => void) | null,
          onerror: null as ((ev: unknown) => void) | null,
          onmessage: null as ((ev: { data: unknown }) => void) | null,
        };
        real.onopen = (ev) => w.onopen?.(ev);
        real.onclose = (ev) => w.onclose?.(ev);
        real.onerror = (ev) => w.onerror?.(ev);
        real.onmessage = (ev) => {
          let data: unknown = ev.data;
          if (rewrite && typeof data === 'string') {
            const env = JSON.parse(data) as { kind: string; stream?: string; client?: string };
            if (env.kind === 'data' && env.stream?.startsWith('pair.')) {
              env.client = rewrite;
              data = JSON.stringify(env);
            }
          }
          w.onmessage?.({ data });
        };
        return w;
      },
    });
    hub.useDispatch(() => Promise.resolve({ status: 200, headers: {}, body: [utf8('ok')] }));
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const victimKey = await generateEd25519();
    const victim = await pair('ABCD-EFGH', victimKey);
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'approved', 'dev-1');
    const vc = start(victim.paired);
    await vc.waitForPaired();
    // A later claim arrives under the victim's id; Add Device would refuse it (expired).
    rewrite = victim.paired.clientId;
    seam.fail = 'this code has expired or was already used';
    await pair('JKMN-PQRS');
    await until(() => audit.some((a) => a.detail?.reason === 'client_conflict'));
    expect(rows().find((r) => r.id === victim.paired.clientId)).toMatchObject({
      status: 'active',
      request_id: 'req-1',
      device_id: 'dev-1',
    });
    expect(await (await vc.fetch('/api/v1/x')).text()).toBe('ok');
    // The same under a claim Add Device would accept: still not touched.
    seam.fail = null;
    await pair('TVWX-YZ12');
    await until(() => audit.filter((a) => a.detail?.reason === 'client_conflict').length === 2);
    expect(seam.claims).toHaveLength(1);
    expect(rows().find((r) => r.id === victim.paired.clientId)?.request_id).toBe('req-1');
    // And the victim's key can still pair on its own.
    rewrite = null;
    await pair('QRST-2345', victimKey);
    await until(() => seam.claims.length === 2);
  });

  it('drops a claim that arrives after its pairing expired', async () => {
    let skew = 0;
    hub = makeHub({ now: () => new Date(Date.now() + skew) });
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const slot = await hub.openPairing({
      accountId: ACCOUNT,
      pairingId: 'add-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      code: 'ABCD-EFGH',
    });
    // The Relay held the claim back past the slot's life (the Hub's clock says so).
    skew = 120_000;
    const out = await pairWithRelay({
      relayUrl: slot.relayUrl,
      relayPairingId: slot.relayPairingId,
      code: 'ABCD-EFGH',
      device: await generateEd25519(),
      name: 'Phone',
      platform: 'android',
      kdfIterations: ITER,
    });
    await until(() => audit.some((a) => a.detail?.reason === 'expired'));
    expect(audit.find((a) => a.detail?.reason === 'expired')).toMatchObject({
      action: 'relay.pair',
      decision: 'refused',
      kind: 'network',
    });
    expect(seam.claims).toHaveLength(0);
    expect(rows()).toEqual([]);
    void out;
  });

  it('blocks only revoked keys; denied and expired keys may pair again', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const key = await generateEd25519();
    await pair('ABCD-EFGH', key);
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'expired', null);
    expect(rows()[0]!.status).toBe('expired');
    expect(audit.at(-1)).toMatchObject({ action: 'relay.pair', decision: 'expired' });
    await pair('JKMN-PQRS', key);
    await until(() => seam.claims.length === 2);
    await seam.decide(1, 'denied', null);
    expect(rows()[1]!.status).toBe('denied');
    await pair('TVWX-YZ12', key);
    await until(() => seam.claims.length === 3);
    // A key Add Device has revoked is refused, and the refusal is audited.
    const revoked = await generateEd25519();
    seam.revokedKeys.add(revoked.publicKey);
    await pair('QRST-2345', revoked);
    await until(() => audit.some((a) => a.detail?.reason === 'revoked_key'));
    expect(seam.claims).toHaveLength(3);
    expect(rows().at(-1)!.status).toBe('denied');
    // A decision for another account or request changes nothing.
    for (const fn of seam.listeners)
      await fn({
        accountId: 'someone-else',
        requestId: 'req-3',
        decision: 'approved',
        deviceId: 'x',
        relayClientId: seam.claims[2]!.relayClientId,
      });
    expect(rows()[2]!.status).toBe('pending');
  });

  it('stores the stream floor before a request runs, and refuses it when that fails', async () => {
    const seen: number[] = [];
    hub.useDispatch((req) => {
      // By now the floor covering this request's stream is on disk.
      seen.push(
        (db.raw.prepare('SELECT stream_floor FROM relay_client').get() as { stream_floor: number })
          .stream_floor,
      );
      return Promise.resolve({ status: 200, headers: {}, body: [utf8(req.path)] });
    });
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'approved', null);
    const c = start(out.paired);
    await c.waitForPaired();
    expect(await (await c.fetch('/api/v1/a')).text()).toBe('/api/v1/a');
    expect(seen[0]).toBeGreaterThan(0);
    // A write that fails refuses the stream: the request never runs.
    db.raw.exec(`CREATE TRIGGER no_floor BEFORE UPDATE OF stream_floor ON relay_client
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const failed = c.fetch('/api/v1/b');
    failed.catch(() => undefined);
    await until(() =>
      logs.records.some((l) => l.msg.startsWith('the stream floor was not stored')),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(1);
  });

  it('counts only authenticated frames as the client being seen', async () => {
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const out = await pair();
    await until(() => seam.claims.length === 1);
    await seam.decide(0, 'approved', null);
    // A frame on the client's route that does not open with its key.
    const ws = new WebSocket(`${url.replace('http', 'ws')}/v1/relay/connect`, [
      'nova-relay.v1',
      `bearer.${out.paired.routeToken}`,
    ]);
    await new Promise((r) => (ws.onopen = r));
    ws.send(
      JSON.stringify({
        v: 1,
        kind: 'data',
        to: out.paired.hubRoute,
        from: out.paired.clientRoute,
        client: out.paired.clientId,
        stream: 'c1',
        seq: 1,
        seg: { i: 0, n: 1 },
        ct: 'A'.repeat(64),
      }),
    );
    await until(() => logs.records.some((l) => l.reason === 'bad_seal'));
    ws.close();
    const lastSeen = () =>
      (
        db.raw.prepare('SELECT last_seen_at FROM relay_client').get() as {
          last_seen_at: string | null;
        }
      ).last_seen_at;
    expect(lastSeen()).toBeNull();
    const c = start(out.paired);
    await c.waitForPaired();
    expect((await c.fetch('/api/v1/x')).status).toBe(503);
    await until(() => lastSeen() !== null);
  });

  it('keeps its X25519 key inside WebCrypto and refuses a plain-http Relay elsewhere', async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    await hub.start();
    await until(() => hub.status().state === 'connected');
    const pkcs8 = spy.mock.calls.filter((c) => c[0] === 'pkcs8');
    expect(pkcs8.length).toBeGreaterThan(0);
    expect(pkcs8.every((c) => c[3] === false)).toBe(true);
    spy.mockRestore();
    settings = { enabled: true, url: 'http://relay.example' };
    await hub.reconfigure();
    expect(hub.status()).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('https or wss'),
    });
  });
});
