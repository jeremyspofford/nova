// The trust area on its own (FR-134, docs/22 §5): owner routes against anonymous calls, the
// public root certificate and signed identity, mode changes through this area or the generic
// settings path (audit, event, change log, rollback), renewals, the seams other areas use, and
// the names the leaf certifies.
import { generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NovaError,
  hubIdentityStatementBytes,
  httpStatusFor,
  isNovaError,
  resolveSetting,
  type HubIdentityStatement,
  type SettingKey,
  type TrustView,
} from '@nova/shared';
import {
  HUB_IDENTITY_REF,
  buildCertificate,
  ed25519FromRaw,
  rawEd25519,
  type AuditRecord,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry, type HubContext } from '../src/hub-context.ts';
import { hubNames, setupTrust, type TrustArea, type TrustChangeLog } from '../src/trust.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OWNER = { authorization: 'Bearer owner' };

let db: NovaDatabase;
let app: FastifyInstance;
let area: TrustArea;
let events: EventStore;
let audit: AuditRecord[];
let diagnostics: DiagnosticsRegistry;
let url: string;
let managed: Record<string, unknown>;
let secrets: MemorySecretStore;

/** Settings as the Hub resolves them: managed policy, then stored global rows, then defaults. */
function setting<K extends SettingKey>(key: K) {
  const rows = db.raw
    .prepare("SELECT key, value_json FROM setting WHERE scope_kind = 'global'")
    .all() as { key: string; value_json: string }[];
  const global = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  return Promise.resolve(resolveSetting(key, { global, managed }).value);
}

/** What the generic settings route does: store one value and announce it. */
async function writeSetting(key: string, value: unknown) {
  db.raw
    .prepare(
      `INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at)
       VALUES (?, 'global', '', ?, ?)
       ON CONFLICT (key, scope_kind, scope_ref) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
  await events.emit({
    name: 'settings.changed',
    actor: 'user',
    accountId: ACCOUNT,
    payload: { key, scope: 'global' },
  });
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  audit = [];
  managed = {};
  diagnostics = new DiagnosticsRegistry();
  events = new EventStore(db);
  secrets = new MemorySecretStore();
  const ctx = {
    db,
    secrets,
    events,
    config: { host: '127.0.0.1', allowedOrigins: ['https://hub.example.net'] },
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    diagnostics,
    setting,
    accountOf: (req: { headers: Record<string, unknown> }) => {
      if (req.headers.authorization !== 'Bearer owner')
        return Promise.reject(new NovaError('token_required', 'sign in'));
      return Promise.resolve(ACCOUNT);
    },
  } as unknown as HubContext;
  area = await setupTrust(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    hostname: () => 'Nova-Hub.lan',
    interfaces: () => ({
      eth0: [
        {
          address: '192.168.1.20',
          family: 'IPv4',
          internal: false,
          netmask: '255.255.255.0',
          mac: '00:00:00:00:00:01',
          cidr: '192.168.1.20/24',
        },
        {
          address: 'fe80::1',
          family: 'IPv6',
          internal: false,
          netmask: 'ffff:ffff:ffff:ffff::',
          mac: '00:00:00:00:00:01',
          cidr: 'fe80::1/64',
          scopeid: 2,
        },
      ],
    }),
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
    return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
  });
  area.register(app);
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await area.close();
  await app.close();
  db.close();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = OWNER,
) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: res.status, json, buf, type: res.headers.get('content-type') ?? '' };
}

/** A change log like the network area's: records, and rolls back through registered undos. */
function memoryChangeLog() {
  const entries: {
    kind: string;
    summary: string;
    undo: Record<string, unknown>;
    actor?: string;
  }[] = [];
  const handlers = new Map<string, (undo: Record<string, unknown>) => Promise<void>>();
  const log: TrustChangeLog & { entries: typeof entries; rollbackLast(): Promise<void> } = {
    entries,
    record: (e) => (entries.push(e), Promise.resolve(e)),
    registerUndo: (kind, h) => handlers.set(kind, h),
    rollbackLast: async () => {
      const e = entries.at(-1)!;
      await handlers.get(e.kind)!(e.undo);
    },
  };
  return log;
}

describe('the trust area', () => {
  it('keeps owner routes behind a session and the root certificate public', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/trust'],
      ['PATCH', '/api/v1/trust'],
      ['POST', '/api/v1/trust/renew'],
    ] as const) {
      const res = await api(method, path, method === 'GET' ? undefined : {}, {});
      expect(res.status, path).toBe(401);
    }
    // Mode none: there is no root to hand out.
    expect((await api('GET', '/api/v1/trust/ca.pem', undefined, {})).status).toBe(404);
    const view = (await api('GET', '/api/v1/trust')).json as unknown as TrustView;
    expect(view).toMatchObject({
      mode: 'none',
      meshCerts: true,
      pinNativeShells: true,
      ca: null,
      leaf: null,
    });
    expect(view.hubFingerprint).toBe(area.helloFields().hubFingerprint);
    expect(view.hubPublicKey).toBe(area.identity.publicKey);
  });

  it('turns on the local CA: audited, announced, logged for rollback, root downloadable', async () => {
    const changes = memoryChangeLog();
    area.useChangeLog(changes);
    const seen: Record<string, unknown>[] = [];
    events.bus.subscribe('trust.changed', (e) => seen.push(e.payload));
    const res = await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    expect(res.status).toBe(200);
    const view = res.json as unknown as TrustView;
    expect(view.mode).toBe('local-ca');
    expect(view.ca).not.toBeNull();
    expect(view.leaf!.sans).toEqual(
      expect.arrayContaining([
        'localhost',
        'nova-hub.local',
        'hub.example.net',
        '127.0.0.1',
        '192.168.1.20',
      ]),
    );
    // The bare host name is a single label: never certified (finding 6).
    expect(view.leaf!.sans).not.toContain('nova-hub');
    expect(view.leaf!.sans).not.toContain('fe80::1');
    expect(audit.find((a) => a.action === 'trust.change')).toMatchObject({
      actor: 'user',
      kind: 'network',
      detail: { from: { mode: 'none' }, to: { mode: 'local-ca' }, via: 'settings' },
    });
    expect(seen.find((p) => p.reason === 'mode')).toMatchObject({
      mode: 'local-ca',
      previous: { mode: 'none' },
    });
    expect(changes.entries).toEqual([
      expect.objectContaining({
        kind: 'trust.mode',
        undo: { previous: { mode: 'none', meshCerts: true, pinNativeShells: true } },
      }),
    ]);
    // The root, public, as PEM and DER, identical to the CA in the view.
    const pem = await api('GET', '/api/v1/trust/ca.pem', undefined, {});
    expect(pem.status).toBe(200);
    expect(pem.type).toContain('application/x-pem-file');
    const x = new X509Certificate(pem.buf);
    expect(x.ca).toBe(true);
    expect(x.fingerprint256).toBe(view.ca!.fingerprint);
    const der = await api('GET', '/api/v1/trust/ca.crt', undefined, {});
    expect(der.type).toContain('application/x-x509-ca-cert');
    expect(new X509Certificate(der.buf).fingerprint256).toBe(view.ca!.fingerprint);
    // Rollback writes the previous values back without logging a new change.
    await changes.rollbackLast();
    expect(await setting('trust.mode')).toBe('none');
    expect(changes.entries).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'trust.change').at(-1)!.detail).toMatchObject({
      via: 'rollback',
      to: { mode: 'none' },
    });
    expect((await api('GET', '/api/v1/trust/ca.pem', undefined, {})).status).toBe(404);
  });

  it('treats a change through the generic settings route the same way', async () => {
    const changes = memoryChangeLog();
    area.useChangeLog(changes);
    // A settings event for another key is ignored.
    await writeSetting('devices.wakesPerHour', 3);
    await writeSetting('trust.pinNativeShells', false);
    await vi.waitFor(() => expect(changes.entries).toHaveLength(1));
    expect(changes.entries[0]!.summary).toContain('pinning off');
    expect(audit.filter((a) => a.action === 'trust.change')).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          to: expect.objectContaining({ pinNativeShells: false }),
        }),
      }),
    ]);
    // The same value again is no change.
    await writeSetting('trust.pinNativeShells', false);
    await area.close(); // waits for pending changes
    expect(changes.entries).toHaveLength(1);
  });

  it('validates the body and refuses an undo it cannot read', async () => {
    expect((await api('PATCH', '/api/v1/trust', {})).status).toBe(400);
    expect((await api('PATCH', '/api/v1/trust', { mode: 'public-ca' })).status).toBe(400);
    expect((await api('PATCH', '/api/v1/trust', { mode: 'none', extra: 1 })).status).toBe(400);
    const changes = memoryChangeLog();
    area.useChangeLog(changes);
    changes.entries.push({
      kind: 'trust.mode',
      summary: 'x',
      undo: { previous: { mode: 'bogus' } },
    });
    await expect(changes.rollbackLast()).rejects.toThrow('cannot be undone');
  });

  it('renews on request, and says when there is nothing to renew', async () => {
    const off = await api('POST', '/api/v1/trust/renew', {});
    expect(off.status).toBe(409);
    expect(off.json.error).toMatchObject({ details: { reason: 'trust_off' } });
    await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    const before = ((await api('GET', '/api/v1/trust')).json as unknown as TrustView).leaf!.serial;
    const res = await api('POST', '/api/v1/trust/renew', { target: 'leaf' });
    expect(res.status).toBe(200);
    expect((res.json as unknown as TrustView).leaf!.serial).not.toBe(before);
    expect(audit.filter((a) => a.action === 'trust.leaf.issue').at(-1)).toMatchObject({
      actor: 'user',
      detail: { reason: 'manual' },
    });
    const mesh = await api('POST', '/api/v1/trust/renew', { target: 'mesh' });
    expect(mesh.status).toBe(409);
    expect(mesh.json.error).toMatchObject({ details: { reason: 'no_mesh_cert' } });
    expect((await api('POST', '/api/v1/trust/renew', { target: 'other' })).status).toBe(400);
  });

  it('renews mesh certificates through the mesh source', async () => {
    const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const host = 'hub.tail1234.ts.net';
    const calls: string[] = [];
    area.useMeshCerts({
      request: (h) => {
        calls.push(h);
        const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const pem = buildCertificate({
          subject: { commonName: h },
          issuer: { commonName: 'Mesh CA' },
          publicKey: leaf.publicKey,
          signer: ca.privateKey,
          notBefore: new Date(Date.now() - 3_600_000),
          notAfter: new Date(Date.now() + 90 * 86_400_000),
          keyUsage: 0x80,
          extKeyUsage: ['1.3.6.1.5.5.7.3.1'],
          altNames: { hosts: [h] },
        }).pem;
        return Promise.resolve({
          certPem: pem,
          keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          notAfter: new Date(),
        });
      },
    });
    await api('PATCH', '/api/v1/trust', { mode: 'mesh' });
    expect(await area.tls.material()).toBeNull();
    expect((await area.requestMeshCert(host)).host).toBe(host);
    expect((await area.tls.material())!.sni.map((s) => s.host)).toEqual([host]);
    const res = await api('POST', '/api/v1/trust/renew', {});
    expect(res.status).toBe(200);
    expect(calls).toEqual([host, host]);
    expect((res.json as unknown as TrustView).meshCert).toMatchObject({ host, status: 'ok' });
    expect((await area.trustSummary()).meshCert).toMatchObject({ host });
  });

  it('serves a signed identity statement anyone can check against the pin', async () => {
    await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    const nonce = 'client-nonce-0123456789';
    const res = await api('GET', `/api/v1/trust/identity?nonce=${nonce}`, undefined, {});
    expect(res.status).toBe(200);
    const s = res.json as unknown as HubIdentityStatement;
    const { signature, ...rest } = s;
    expect(s.nonce).toBe(nonce);
    expect(s.hubFingerprint).toBe(area.identity.fingerprint);
    expect(
      verify(
        null,
        Buffer.from(hubIdentityStatementBytes(rest)),
        ed25519FromRaw(s.hubPublicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(s.certificates.map((c) => c.kind)).toEqual(['ca', 'leaf']);
    // The nonce is required and bounded (finding 10).
    for (const q of [
      '',
      '?nonce=short',
      `?nonce=${'x'.repeat(65)}`,
      '?nonce=not%20base64url%20at%20all',
      `?nonce=${nonce}&extra=1`,
    ])
      expect((await api('GET', `/api/v1/trust/identity${q}`, undefined, {})).status, q).toBe(400);
  });

  it('replaces the CA only when the owner asks for it explicitly', async () => {
    expect((await api('POST', '/api/v1/trust/renew', { target: 'ca' }, {})).status).toBe(401);
    const off = await api('POST', '/api/v1/trust/renew', { target: 'ca' });
    expect(off.json.error).toMatchObject({ details: { reason: 'trust_off' } });
    await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    const before = ((await api('GET', '/api/v1/trust')).json as unknown as TrustView).ca!;
    // `all` renews the leaf, never the CA.
    await api('POST', '/api/v1/trust/renew', { target: 'all' });
    expect(((await api('GET', '/api/v1/trust')).json as unknown as TrustView).ca!.fingerprint).toBe(
      before.fingerprint,
    );
    const res = await api('POST', '/api/v1/trust/renew', { target: 'ca' });
    expect(res.status).toBe(200);
    const after = res.json as unknown as TrustView;
    expect(after.ca!.fingerprint).not.toBe(before.fingerprint);
    expect(after.leaf).not.toBeNull();
    expect(audit.find((a) => a.action === 'trust.ca.rotate')).toMatchObject({ actor: 'user' });
    await api('PATCH', '/api/v1/trust', { mode: 'mesh' });
    const mesh = await api('POST', '/api/v1/trust/renew', { target: 'ca' });
    expect(mesh.json.error).toMatchObject({ details: { reason: 'no_local_ca' } });
  });

  it('gives other areas the identity, the certificate issuer, revocation and a summary', async () => {
    const sig = area.identity.sign('manifest');
    expect(
      verify(null, Buffer.from('manifest'), ed25519FromRaw(area.identity.publicKey), sig),
    ).toBe(true);
    const device = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    expect(
      await area.certIssuer.issueDeviceCertificate({
        deviceId: 'dev-9',
        publicKey: device,
        role: 'client',
      }),
    ).toBeNull();
    await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    const issued = (await area.certIssuer.issueDeviceCertificate({
      deviceId: 'dev-9',
      publicKey: device,
      role: 'client',
    }))!;
    expect(area.verifyDeviceCertificate(issued.certificatePem).ok).toBe(true);
    expect(await area.revokeDevice('dev-9')).toBe(1);
    expect(area.verifyDeviceCertificate(issued.certificatePem)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    const local = await area.ensureLocalCa();
    expect(new X509Certificate(local.certPem).fingerprint256).toBe(local.fingerprint);
    const summary = await area.trustSummary();
    expect(summary).toMatchObject({ mode: 'local-ca', caFingerprint: local.fingerprint });
    expect(summary.leafSans).toContain('nova-hub.local');
    const diag = await diagnostics.collect();
    expect(diag.trust).toMatchObject({ mode: 'local-ca', caFingerprint: local.fingerprint });
    // Names other areas add join the leaf.
    area.useHostnames(() => Promise.resolve(['studio.local']));
    await api('POST', '/api/v1/trust/renew', { target: 'leaf' });
    expect((await area.trustSummary()).leafSans).toContain('studio.local');
  });

  it('tells the listener about renewals and reports what it serves', async () => {
    await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    let changed = 0;
    const off = area.tls.onChange(() => changed++);
    area.tls.reportServing({ scheme: 'https', source: 'trust' });
    await api('POST', '/api/v1/trust/renew', { target: 'leaf' });
    expect(changed).toBe(1);
    off();
    const view = (await api('GET', '/api/v1/trust')).json as unknown as TrustView;
    expect(view.serving).toEqual({ scheme: 'https', source: 'trust' });
    expect(view.restartRequired).toBe(false);
    await api('PATCH', '/api/v1/trust', { mode: 'none' });
    expect(((await api('GET', '/api/v1/trust')).json as unknown as TrustView).restartRequired).toBe(
      true,
    );
  });
});

describe('the trust area under managed policy and a failing vault', () => {
  it('refuses a mode managed policy sets, and stores nothing', async () => {
    managed['trust.mode'] = 'none';
    const res = await api('PATCH', '/api/v1/trust', { mode: 'local-ca' });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: 'policy_denied', details: { reason: 'managed' } });
    expect(
      db.raw.prepare("SELECT count(*) AS n FROM setting WHERE key = 'trust.mode'").get(),
    ).toEqual({ n: 0 });
    expect(audit.filter((a) => a.action === 'trust.change')).toEqual([]);
  });

  it('starts without the identity key when the vault fails, and loads it on first use', async () => {
    // The same identity key in a vault that fails to read at first.
    const store = new MemorySecretStore();
    await store.put(HUB_IDENTITY_REF, (await secrets.get(HUB_IDENTITY_REF))!);
    let failing = true;
    const flaky = {
      kind: 'flaky',
      get: (ref: string) => (failing ? Promise.reject(new Error('vault locked')) : store.get(ref)),
      put: (ref: string, value: string) => store.put(ref, value),
      has: (ref: string) => store.has(ref),
      delete: (ref: string) => store.delete(ref),
      list: (prefix?: string) => store.list(prefix),
    };
    const ctx = {
      db,
      secrets: flaky,
      events,
      config: { host: '127.0.0.1', allowedOrigins: [] },
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      diagnostics: new DiagnosticsRegistry(),
      setting,
      accountOf: () => Promise.resolve(ACCOUNT),
    } as unknown as HubContext;
    const other = await setupTrust(ctx, { hostname: () => 'h', interfaces: () => ({}) });
    try {
      expect(other.helloFields()).toEqual({ hubFingerprint: null, hubPublicKey: null });
      failing = false;
      const statement = await other.service.identityStatement('nonce-for-this-check');
      expect(other.helloFields().hubFingerprint).toBe(statement.hubFingerprint);
      expect(statement.hubFingerprint).toBe(area.identity.fingerprint);
    } finally {
      await other.close();
    }
  });
});

describe('the trust area without its identity key (finding 2)', () => {
  it('stays down: hello fields null, problems say why, nothing served, no new identity', async () => {
    // The key recorded by the area set up in beforeEach, then a vault without it.
    const fp = area.identity.fingerprint;
    const empty = new MemorySecretStore();
    const ctx = {
      db,
      secrets: empty,
      events,
      config: { host: '127.0.0.1', allowedOrigins: [] },
      log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
      diagnostics: new DiagnosticsRegistry(),
      setting,
      accountOf: () => Promise.resolve(ACCOUNT),
    } as unknown as HubContext;
    const down = await setupTrust(ctx, { hostname: () => 'h', interfaces: () => ({}) });
    const app2 = Fastify();
    app2.setErrorHandler((err, _req, reply) => {
      if (isNovaError(err))
        return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON() });
      return reply.status(400).send({ error: { code: 'validation', message: String(err) } });
    });
    down.register(app2);
    try {
      expect(down.helloFields()).toEqual({ hubFingerprint: null, hubPublicKey: null });
      const view = await down.service.view();
      expect(view.hubFingerprint).toBeNull();
      expect(view.problems.join(' ')).toContain(`Hub identity key ${fp} is missing`);
      expect((await down.trustSummary()).problems.join(' ')).toContain('trust area is off');
      await expect(down.tls.material()).rejects.toMatchObject({
        details: { reason: 'identity_missing' },
      });
      const st = await app2.inject({
        method: 'GET',
        url: '/api/v1/trust/identity?nonce=client-nonce-0123456789',
      });
      expect(st.statusCode).toBe(409);
      expect(await empty.list()).toEqual([]);
    } finally {
      await down.close();
      await app2.close();
    }
  });
});

describe('hubNames', () => {
  it('lists the configured names, the host name and its .local name, and usable addresses', () => {
    const names = hubNames(
      {
        host: '0.0.0.0',
        allowedOrigins: ['https://nova.example.org:8443', 'not a url', 'http://[fd00::5]:7419'],
      },
      'Studio_PC.home',
      {
        lo: [
          {
            address: '127.0.0.1',
            family: 'IPv4',
            internal: true,
            netmask: '255.0.0.0',
            mac: '00:00:00:00:00:00',
            cidr: '127.0.0.1/8',
          },
        ],
        wlan0: [
          {
            address: '10.1.2.3',
            family: 'IPv4',
            internal: false,
            netmask: '255.0.0.0',
            mac: '00:00:00:00:00:02',
            cidr: '10.1.2.3/8',
          },
          {
            address: 'FE80::2',
            family: 'IPv6',
            internal: false,
            netmask: 'ffff::',
            mac: '00:00:00:00:00:02',
            cidr: 'fe80::2/64',
            scopeid: 3,
          },
        ],
      },
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'localhost',
        'nova.example.org',
        'fd00::5',
        'studio-pc.local',
        'studio_pc.home',
        '127.0.0.1',
        '10.1.2.3',
      ]),
    );
    expect(names).not.toContain('0.0.0.0');
    // The bare host name is a single label: left out (finding 6).
    expect(names).not.toContain('studio-pc');
    expect(hubNames({ host: '0.0.0.0', allowedOrigins: [] }, 'dev', {})).toEqual([
      'localhost',
      'dev.local',
    ]);
    expect(names.some((n) => n.toLowerCase().startsWith('fe80'))).toBe(false);
    expect(hubNames({ host: '192.168.0.9', allowedOrigins: [] }, '', {})).toEqual([
      'localhost',
      '192.168.0.9',
    ]);
  });
});
