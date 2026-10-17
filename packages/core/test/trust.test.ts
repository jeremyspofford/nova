// Trust paths (FR-134, docs/22 §5): the Hub identity key, the Hub local CA and its TLS leaf
// (renewal, names, real TLS handshakes), device certificates and revocation, mesh certificates,
// and the signed statement native shells check against their pin.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
  X509Certificate,
} from 'node:crypto';
import { connect, createSecureContext, createServer } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubIdentityStatementBytes, type TrustMode } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  HUB_IDENTITY_REF,
  HubIdentity,
  MemoryEventSink,
  TrustService,
  checkHubIdentity,
  ed25519FromRaw,
  hubFingerprint,
  rawEd25519,
  type AuditRecord,
  type TlsMaterial,
} from '../src/index.ts';
import { buildCertificate } from '../src/trust/x509.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-17T12:00:00Z');
const NONCE = 'n0nce-from-the-client_1';

let db: NovaDatabase;
let secrets: MemorySecretStore;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  secrets = new MemorySecretStore();
});

afterEach(() => db.close());

interface Rig {
  svc: TrustService;
  settings: { mode: TrustMode; meshCerts: boolean; pinNativeShells: boolean };
  names: string[];
  clock: { t: number } | null;
  audit: AuditRecord[];
  events: MemoryEventSink;
}

function rig(opts: { mode?: TrustMode; clock?: boolean; names?: string[] } = {}): Rig {
  const r: Rig = {
    svc: null as unknown as TrustService,
    settings: { mode: opts.mode ?? 'local-ca', meshCerts: true, pinNativeShells: true },
    names: opts.names ?? [
      'nova-hub',
      'nova-hub.local',
      '192.168.1.20',
      '2001:db8::5',
      'fe80::1%eth0',
    ],
    clock: opts.clock ? { t: T0 } : null,
    audit: [],
    events: new MemoryEventSink(),
  };
  r.svc = new TrustService({
    db,
    secrets,
    settings: {
      mode: () => Promise.resolve(r.settings.mode),
      meshCerts: () => Promise.resolve(r.settings.meshCerts),
      pinNativeShells: () => Promise.resolve(r.settings.pinNativeShells),
    },
    names: () => Promise.resolve(r.names),
    events: r.events,
    audit: { append: (rec) => (r.audit.push(rec), Promise.resolve()) },
    ownerAccount: () => Promise.resolve(ACCOUNT),
    ...(r.clock ? { now: () => new Date(r.clock!.t) } : {}),
  });
  return r;
}

/** Serve `material` on loopback; connect as a client trusting `ca` (or the system roots). */
async function handshake(
  material: TlsMaterial,
  servername: string | undefined,
  ca: string | undefined,
): Promise<{ result: string; peer: string | null }> {
  const contexts = new Map(
    material.sni.map((s) => [s.host, createSecureContext({ cert: s.cert, key: s.key })]),
  );
  const server = createServer(
    {
      cert: material.cert,
      key: material.key,
      SNICallback: (name, cb) => cb(null, contexts.get(name) ?? undefined),
    },
    (s) => s.end('ok'),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  try {
    return await new Promise((resolve) => {
      const c = connect(
        { host: '127.0.0.1', port, ...(servername ? { servername } : {}), ...(ca ? { ca } : {}) },
        () => {
          const peer = c.getPeerX509Certificate()?.subjectAltName ?? null;
          c.on('data', (b: Buffer) => resolve({ result: String(b), peer }));
        },
      );
      c.on('error', (err) => resolve({ result: err.message, peer: null }));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('Hub identity', () => {
  it('is created once in the vault and survives a restart', async () => {
    const a = new HubIdentity({ secrets, db });
    await a.load();
    await a.load();
    expect(await secrets.list('secret://hub/')).toEqual([HUB_IDENTITY_REF]);
    const b = new HubIdentity({ secrets, db });
    await b.load();
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.helloFields()).toEqual({ hubFingerprint: a.fingerprint, hubPublicKey: a.publicKey });
  });

  it('fingerprints and signs like RFC 8032 test 1', async () => {
    // RFC 8032 §7.1 TEST 1: a published test vector, not a secret. secret-scan: fake
    const d = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A'; // secret-scan: fake
    const x = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' });
    await secrets.put(HUB_IDENTITY_REF, key.export({ type: 'pkcs8', format: 'pem' }).toString());
    const id = new HubIdentity({ secrets, db });
    await id.load();
    expect(id.publicKey).toBe(x);
    expect(id.fingerprint).toBe('If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk');
    expect(hubFingerprint(Buffer.from(x, 'base64url'))).toBe(id.fingerprint);
    expect(id.sign(new Uint8Array()).toString('hex')).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('signs what node:crypto verifies with the published key, and nothing else', async () => {
    const id = new HubIdentity({ secrets, db });
    expect(() => id.fingerprint).toThrow('not loaded');
    await id.load();
    const sig = id.sign('manifest bytes');
    const pub = ed25519FromRaw(id.publicKey);
    expect(verify(null, Buffer.from('manifest bytes'), pub, sig)).toBe(true);
    expect(verify(null, Buffer.from('manifest bytez'), pub, sig)).toBe(false);
    expect(id.verify('manifest bytes', sig)).toBe(true);
    expect(rawEd25519(pub).toString('base64url')).toBe(id.publicKey);
  });

  it('records its public key and never makes a new one when the vault lost it (finding 2)', async () => {
    const a = new HubIdentity({ secrets, db });
    await a.load();
    expect(
      db.raw.prepare('SELECT public_key, fingerprint, key_ref FROM trust_identity').get(),
    ).toEqual({
      public_key: a.publicKey,
      fingerprint: a.fingerprint,
      key_ref: HUB_IDENTITY_REF,
    });
    // The same database with a vault that lacks the key (a keychain the service cannot reach).
    const empty = new MemorySecretStore();
    const b = new HubIdentity({ secrets: empty, db });
    await expect(b.load()).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'identity_missing' },
    });
    expect(b.loaded).toBe(false);
    expect(b.failure!.message).toContain(a.fingerprint);
    expect(await empty.list()).toEqual([]);
    // Still refused on the next try, and the recorded key is unchanged.
    await expect(b.load()).rejects.toMatchObject({ details: { reason: 'identity_missing' } });
    expect(
      db.raw.prepare('SELECT count(*) AS n, max(public_key) AS k FROM trust_identity').get(),
    ).toEqual({
      n: 1,
      k: a.publicKey,
    });
  });

  it('refuses a different key in the vault, and a vault that cannot be read', async () => {
    const a = new HubIdentity({ secrets, db });
    await a.load();
    const swapped = new MemorySecretStore();
    const other = generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    await swapped.put(HUB_IDENTITY_REF, other.toString());
    await expect(new HubIdentity({ secrets: swapped, db }).load()).rejects.toMatchObject({
      details: { reason: 'identity_mismatch' },
    });
    expect(await swapped.get(HUB_IDENTITY_REF)).toBe(other.toString());
    const locked = {
      kind: 'locked',
      get: () => Promise.reject(new Error('keychain locked')),
      put: () => Promise.reject(new Error('keychain locked')),
      has: () => Promise.resolve(false),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
    };
    await expect(new HubIdentity({ secrets: locked, db }).load()).rejects.toMatchObject({
      details: { reason: 'identity_unavailable' },
    });
  });

  it('adopts a key the vault already holds when nothing was recorded', async () => {
    const key = generateKeyPairSync('ed25519').privateKey;
    await secrets.put(HUB_IDENTITY_REF, key.export({ type: 'pkcs8', format: 'pem' }).toString());
    const id = new HubIdentity({ secrets, db });
    await id.load();
    expect(id.publicKey).toBe(rawEd25519(createPublicKey(key)).toString('base64url'));
    expect(db.raw.prepare('SELECT public_key FROM trust_identity').get()).toEqual({
      public_key: id.publicKey,
    });
  });

  it('keeps the whole trust area down while the identity key is missing', async () => {
    const first = rig();
    await first.svc.start();
    await first.svc.ensureLeaf();
    const fp = first.svc.identity.fingerprint;
    const ca = first.svc.caCertificate();
    secrets = new MemorySecretStore();
    const r = rig();
    await expect(r.svc.start()).rejects.toMatchObject({ details: { reason: 'identity_missing' } });
    await expect(r.svc.tlsMaterial()).rejects.toMatchObject({
      details: { reason: 'identity_missing' },
    });
    await expect(r.svc.identityStatement(NONCE)).rejects.toMatchObject({ code: 'conflict' });
    await r.svc.maintain();
    const view = await r.svc.view();
    expect(view.hubFingerprint).toBeNull();
    expect(view.problems.join(' ')).toContain(`Hub identity key ${fp} is missing`);
    expect(r.svc.caCertificate()).toBe(ca);
    expect(await secrets.list()).toEqual([]);
  });

  it('refuses a vault entry that is not an Ed25519 key, and malformed device keys', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await secrets.put(
      HUB_IDENTITY_REF,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const id = new HubIdentity({ secrets, db });
    await expect(id.load()).rejects.toThrow('not an Ed25519 key');
    expect(() => ed25519FromRaw('short')).toThrow('raw 32-byte');
    expect(() => rawEd25519(createPublicKey(privateKey))).toThrow('not an Ed25519 key');
  });
});

describe('the Hub local CA and its TLS leaf', () => {
  it('issues a CA and a leaf that parse and verify, with the Hub names as SANs', async () => {
    const r = rig();
    await r.svc.start();
    const material = await r.svc.tlsMaterial();
    expect(material).not.toBeNull();
    const caPem = r.svc.caCertificate()!;
    const ca = new X509Certificate(caPem);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain(`CN=Nova Hub local CA ${r.svc.identity.fingerprint.slice(0, 8)}`);
    expect(new Date(ca.validTo).getTime() - Date.now()).toBeGreaterThan(3600 * DAY);
    const leaf = new X509Certificate(material!.cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    // The CA comes second in the chain.
    expect(material!.cert).toContain(caPem.trim());
    expect(leaf.subjectAltName?.split(', ').sort()).toEqual(
      [
        'DNS:localhost',
        'DNS:nova-hub.local',
        'IP Address:127.0.0.1',
        'IP Address:0:0:0:0:0:0:0:1',
        'IP Address:192.168.1.20',
      ].sort(),
    );
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY;
    expect(Math.round(days)).toBe(90);
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    // The private keys are vault entries; the database holds certificates and references only.
    const dump =
      JSON.stringify(db.raw.prepare('SELECT * FROM trust_certificate').all()) +
      JSON.stringify(db.raw.prepare('SELECT * FROM trust_ca').all());
    expect(dump).not.toContain('PRIVATE KEY');
    expect((await secrets.list('secret://hub/')).sort()).toEqual(
      expect.arrayContaining([HUB_IDENTITY_REF]),
    );
    expect(r.audit.map((a) => a.action)).toEqual(['trust.ca.create', 'trust.leaf.issue']);
    expect(r.audit.every((a) => a.kind === 'network' && a.accountId === ACCOUNT)).toBe(true);
    expect(r.events.events.map((e) => e.payload.reason)).toEqual(['ca_created', 'leaf_issued']);
  });

  it('serves a TLS handshake a client accepts only when it trusts the CA', async () => {
    const r = rig();
    const material = (await r.svc.tlsMaterial())!;
    const caPem = r.svc.caCertificate()!;
    expect((await handshake(material, 'nova-hub.local', caPem)).result).toBe('ok');
    // By address: no SNI, the IP SAN matches.
    expect((await handshake(material, undefined, caPem)).result).toBe('ok');
    const untrusted = await handshake(material, 'nova-hub.local', undefined);
    expect(untrusted.result).not.toBe('ok');
    // A name the leaf does not carry fails the identity check.
    const wrong = await handshake(material, 'other.local', caPem);
    expect(wrong.result).toMatch(/altnames|does not match/i);
  });

  it('keeps names outside the CA constraints out of the leaf and reports them', async () => {
    const r = rig();
    await r.svc.ensureLeaf();
    r.names = [...r.names, 'nova.example.org'];
    const leaf = await r.svc.ensureLeaf();
    expect(JSON.parse(leaf.sans_json)).not.toContain('nova.example.org');
    const summary = await r.svc.summary();
    expect(summary.problems.join('\n')).toContain('nova.example.org is outside');
    const view = await r.svc.view();
    expect(view.ca!.nameConstraints.dns).toEqual(['local', 'localhost', 'home.arpa', 'internal']);
    expect(view.ca!.nameConstraints.dns).not.toContain('nova.example.org');
  });

  it('adds the names the Hub has when the CA is created to its constraints', async () => {
    const r = rig({ names: ['hub.example.net'] });
    const leaf = await r.svc.ensureLeaf();
    expect(JSON.parse(leaf.sans_json)).toContain('hub.example.net');
    expect((await r.svc.view()).ca!.nameConstraints.dns).toContain('hub.example.net');
    const material = (await r.svc.tlsMaterial())!;
    expect((await handshake(material, 'hub.example.net', r.svc.caCertificate()!)).result).toBe(
      'ok',
    );
  });

  it('never certifies or permits a single-label name (finding 6)', async () => {
    const r = rig({ names: ['dev', 'nova-hub', 'nova-hub.local', 'hub.example.net'] });
    const leaf = await r.svc.ensureLeaf();
    const sans = JSON.parse(leaf.sans_json) as string[];
    expect(sans).not.toContain('dev');
    expect(sans).not.toContain('nova-hub');
    expect(sans).toEqual(
      expect.arrayContaining(['nova-hub.local', 'hub.example.net', 'localhost']),
    );
    const view = await r.svc.view();
    expect(view.ca!.nameConstraints.dns).toEqual([
      'local',
      'localhost',
      'home.arpa',
      'internal',
      'hub.example.net',
    ]);
    expect(view.problems.join(' ')).toContain('dev is a single-label name');
    // Even with the CA key, a certificate for a public .dev site does not verify.
    const caRow = db.raw.prepare('SELECT key_ref FROM trust_ca').get() as { key_ref: string };
    const caKey = createPrivateKey((await secrets.get(caRow.key_ref))!);
    const caPem = r.svc.caCertificate()!;
    const site = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const evil = buildCertificate({
      subject: { commonName: 'www.google.dev' },
      issuer: {
        commonName: new X509Certificate(caPem).subject
          .split('\n')
          .find((l) => l.startsWith('CN='))!
          .slice(3),
      },
      publicKey: site.publicKey,
      signer: caKey,
      notBefore: new Date(Date.now() - 3_600_000),
      notAfter: new Date(Date.now() + DAY),
      keyUsage: 0x80,
      extKeyUsage: ['1.3.6.1.5.5.7.3.1'],
      altNames: { hosts: ['www.google.dev'] },
    });
    const key = site.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const res = await handshake({ cert: evil.pem, key, sni: [] }, 'www.google.dev', caPem);
    expect(res.result).not.toBe('ok');
    expect(res.result.toLowerCase()).toContain('subtree');
  });

  it('renews at two thirds of its life with an injected clock', async () => {
    const r = rig({ clock: true });
    const first = await r.svc.ensureLeaf();
    r.clock!.t = T0 + 59 * DAY;
    expect((await r.svc.ensureLeaf()).id).toBe(first.id);
    r.clock!.t = T0 + 61 * DAY;
    const changes: number[] = [];
    r.svc.onTlsChange(() => changes.push(1));
    await r.svc.maintain();
    const second = await r.svc.ensureLeaf();
    expect(second.id).not.toBe(first.id);
    expect(changes).toEqual([1]);
    // The old key left the vault; the old row is kept, superseded.
    expect(await secrets.has(first.key_ref!)).toBe(false);
    const view = await r.svc.view();
    expect(view.leaf!.serial).toBe(second.serial);
    expect(view.issued.find((c) => c.serial === first.serial)!.supersededAt).not.toBeNull();
    expect(Date.parse(view.leaf!.renewAt)).toBe(
      Date.parse(second.not_before) +
        ((Date.parse(second.not_after) - Date.parse(second.not_before)) * 2) / 3,
    );
    expect(
      r.audit.filter((a) => a.action === 'trust.leaf.issue').map((a) => a.detail?.reason),
    ).toEqual(['first', 'expiry']);
  });

  it('issues a new leaf when the names change, and on a forced renewal', async () => {
    const r = rig();
    const first = await r.svc.ensureLeaf();
    expect((await r.svc.ensureLeaf()).id).toBe(first.id);
    r.names = [...r.names, '192.168.1.21'];
    const second = await r.svc.ensureLeaf();
    expect(second.id).not.toBe(first.id);
    expect(JSON.parse(second.sans_json)).toContain('192.168.1.21');
    const third = await r.svc.ensureLeaf({
      force: true,
      who: { actor: 'user', accountId: ACCOUNT },
    });
    expect(third.id).not.toBe(second.id);
    expect(r.audit.at(-1)).toMatchObject({ actor: 'user', action: 'trust.leaf.issue' });
  });

  it('mints one leaf when asked concurrently', async () => {
    const r = rig();
    const [a, b, c] = await Promise.all([
      r.svc.ensureLeaf(),
      r.svc.ensureLeaf(),
      r.svc.tlsMaterial(),
    ]);
    expect(a.id).toBe(b.id);
    expect(c!.cert).toContain(a.cert_pem.trim());
    expect(db.raw.prepare('SELECT count(*) AS n FROM trust_ca').get()).toEqual({ n: 1 });
  });

  it('never replaces a CA whose key left the vault on its own (finding 2)', async () => {
    const r = rig();
    await r.svc.ensureLeaf();
    const publicKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    const device = (await r.svc.issueDeviceCertificate({
      deviceId: 'd1',
      publicKey,
      role: 'client',
    }))!;
    const old = r.svc.caCertificate();
    for (const ref of await secrets.list('secret://hub/ca/')) await secrets.delete(ref);
    // The current leaf is still served; a new one cannot be signed, and no new CA appears.
    expect((await r.svc.tlsMaterial())!.cert).toContain(old!.trim());
    await expect(r.svc.ensureLeaf({ force: true })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'ca_key_missing' },
    });
    await expect(
      r.svc.issueDeviceCertificate({ deviceId: 'd2', publicKey, role: 'client' }),
    ).rejects.toMatchObject({ details: { reason: 'ca_key_missing' } });
    expect(r.svc.caCertificate()).toBe(old);
    expect(
      db.raw.prepare('SELECT count(*) AS n, count(retired_at) AS retired FROM trust_ca').get(),
    ).toEqual({
      n: 1,
      retired: 0,
    });
    expect(r.audit.filter((a) => a.action === 'trust.ca.create')).toHaveLength(1);
    expect(r.svc.verifyDeviceCertificate(device.certificatePem).ok).toBe(true);
    expect((await r.svc.summary()).problems.join(' ')).toContain('local CA key is missing');
  });

  it('refuses a CA key that is not the certificate key', async () => {
    const r = rig();
    await r.svc.ensureLeaf();
    const [ref] = await secrets.list('secret://hub/ca/');
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    await secrets.put(ref!, other.export({ type: 'pkcs8', format: 'pem' }).toString());
    await expect(r.svc.ensureLeaf({ force: true })).rejects.toMatchObject({
      details: { reason: 'ca_key_mismatch' },
    });
  });

  it('keeps the CA when the vault cannot be written (review probe t1)', async () => {
    const r = rig();
    await r.svc.ensureLeaf();
    const before = db.raw.prepare('SELECT id, retired_at FROM trust_ca').all();
    const broken = new TrustService({
      db,
      secrets: {
        kind: 'broken',
        get: (ref: string) => secrets.get(ref),
        has: () => Promise.resolve(false),
        put: () => Promise.reject(new Error('vault unavailable')),
        delete: () => Promise.resolve(false),
        list: () => Promise.resolve([]),
      },
      settings: {
        mode: () => Promise.resolve('local-ca'),
        meshCerts: () => Promise.resolve(false),
        pinNativeShells: () => Promise.resolve(true),
      },
      names: () => Promise.resolve(r.names),
    });
    await broken.start();
    await expect(broken.ensureLeaf()).rejects.toThrow('vault unavailable');
    await expect(broken.rotateCa()).rejects.toThrow('vault unavailable');
    expect(db.raw.prepare('SELECT id, retired_at FROM trust_ca').all()).toEqual(before);
    expect(broken.caCertificate()).toBe(r.svc.caCertificate());
  });

  it('replaces the CA only when asked, atomically, and removes the old keys', async () => {
    const r = rig();
    const firstLeaf = await r.svc.ensureLeaf();
    const publicKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    const device = (await r.svc.issueDeviceCertificate({
      deviceId: 'd1',
      publicKey,
      role: 'client',
    }))!;
    const oldCa = db.raw.prepare('SELECT id, key_ref FROM trust_ca').get() as {
      id: string;
      key_ref: string;
    };
    const fresh = await r.svc.rotateCa({ actor: 'user', accountId: ACCOUNT });
    expect(fresh.id).not.toBe(oldCa.id);
    const rows = db.raw
      .prepare('SELECT id, key_ref, retired_at FROM trust_ca ORDER BY created_at')
      .all() as {
      id: string;
      key_ref: string | null;
      retired_at: string | null;
    }[];
    expect(rows.map((x) => [x.id, x.retired_at === null])).toEqual([
      [oldCa.id, false],
      [fresh.id, true],
    ]);
    // Nothing serves the old CA's key or the old leaf's key any more: both left the vault.
    expect(await secrets.has(oldCa.key_ref)).toBe(false);
    expect(rows[0]!.key_ref).toBeNull();
    expect(await secrets.has(firstLeaf.key_ref!)).toBe(false);
    const material = (await r.svc.tlsMaterial())!;
    expect(
      new X509Certificate(material.cert).checkIssued(new X509Certificate(fresh.cert_pem)),
    ).toBe(true);
    expect((await handshake(material, 'nova-hub.local', fresh.cert_pem)).result).toBe('ok');
    // The old CA's device certificates stop verifying.
    expect(r.svc.verifyDeviceCertificate(device.certificatePem)).toEqual({
      ok: false,
      reason: 'unknown_issuer',
    });
    expect(r.audit.find((a) => a.action === 'trust.ca.rotate')).toMatchObject({ actor: 'user' });
  });

  it('serves nothing in mode none, and reports a restart when the mode differs', async () => {
    const r = rig({ mode: 'none' });
    expect(await r.svc.tlsMaterial()).toBeNull();
    r.svc.reportServing({ scheme: 'http', source: 'none' });
    expect((await r.svc.view()).restartRequired).toBe(false);
    r.settings.mode = 'local-ca';
    const view = await r.svc.view();
    expect(view.restartRequired).toBe(true);
    expect(view.problems.join(' ')).toContain('restart the Hub');
    // An explicit certificate wins over the trust mode: never a restart.
    r.svc.reportServing({ scheme: 'https', source: 'explicit' });
    expect((await r.svc.view()).restartRequired).toBe(false);
  });

  it('keeps a renewal failure as a problem instead of throwing', async () => {
    const r = rig();
    await r.svc.ensureLeaf();
    const failing = new TrustService({
      db,
      secrets: {
        kind: 'broken',
        get: (ref: string) => secrets.get(ref),
        has: () => Promise.resolve(true),
        put: () => Promise.reject(new Error('vault locked')),
        delete: () => Promise.resolve(false),
        list: () => Promise.resolve([]),
      },
      settings: {
        mode: () => Promise.resolve('local-ca'),
        meshCerts: () => Promise.resolve(false),
        pinNativeShells: () => Promise.resolve(true),
      },
      names: () => Promise.resolve(['new-name.local']),
    });
    await failing.maintain();
    expect((await failing.summary()).problems.join(' ')).toContain('vault locked');
  });
});

describe('device certificates', () => {
  it('certify the device key, verify, and stop verifying once revoked', async () => {
    const r = rig();
    const device = generateKeyPairSync('ed25519');
    const publicKey = rawEd25519(device.publicKey).toString('base64url');
    const issued = await r.svc.issueDeviceCertificate({
      deviceId: 'dev-1',
      publicKey,
      role: 'client',
    });
    expect(issued).not.toBeNull();
    const x = new X509Certificate(issued!.certificatePem);
    expect(x.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(rawEd25519(x.publicKey).toString('base64url')).toBe(publicKey);
    const ca = new X509Certificate(r.svc.caCertificate()!);
    expect(x.checkIssued(ca)).toBe(true);
    expect(x.verify(ca.publicKey)).toBe(true);
    expect(x.subjectAltName).toBe('URI:urn:nova:device:dev-1');
    expect(issued!.expiresAt).toBe(new Date(x.validTo).toISOString());
    expect(r.svc.verifyDeviceCertificate(issued!.certificatePem)).toEqual({
      ok: true,
      deviceId: 'dev-1',
      role: 'client',
      serial: issued!.serial,
    });
    expect(await r.svc.revokeDevice('dev-1', 'lost phone')).toBe(1);
    expect(await r.svc.revokeDevice('dev-1')).toBe(0);
    expect(r.svc.verifyDeviceCertificate(issued!.certificatePem)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(r.svc.revocations()).toEqual([
      expect.objectContaining({ serial: issued!.serial, deviceId: 'dev-1' }),
    ]);
    expect(r.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['trust.device.issue', 'trust.device.revoke']),
    );
    expect(r.events.events.at(-1)!.payload).toMatchObject({
      reason: 'device_revoked',
      deviceId: 'dev-1',
    });
  });

  it('are issued only in local-ca mode and only for a well-formed request', async () => {
    const r = rig({ mode: 'none' });
    const publicKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    expect(
      await r.svc.issueDeviceCertificate({ deviceId: 'd', publicKey, role: 'client' }),
    ).toBeNull();
    r.settings.mode = 'local-ca';
    await expect(
      r.svc.issueDeviceCertificate({ deviceId: 'd', publicKey: 'AAAA', role: 'client' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      r.svc.issueDeviceCertificate({ deviceId: 'bad id!', publicKey, role: 'client' }),
    ).rejects.toMatchObject({ code: 'validation' });
    // A dotted id would make the common name look like a host name.
    await expect(
      r.svc.issueDeviceCertificate({ deviceId: 'nova.local', publicKey, role: 'client' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      r.svc.issueDeviceCertificate({ deviceId: 'd', publicKey, role: 'Client Role' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('refuse certificates the Hub did not issue', async () => {
    const r = rig();
    expect(r.svc.verifyDeviceCertificate('not a certificate')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const publicKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    // Before any CA exists.
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const foreign = buildCertificate({
      subject: { commonName: 'dev-2' },
      issuer: { commonName: 'Someone else' },
      publicKey: ed25519FromRaw(publicKey),
      signer: other.privateKey,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + DAY),
      keyUsage: 0x80,
    }).pem;
    expect(r.svc.verifyDeviceCertificate(foreign)).toEqual({ ok: false, reason: 'no_ca' });
    await r.svc.issueDeviceCertificate({ deviceId: 'dev-1', publicKey, role: 'compute' });
    expect(r.svc.verifyDeviceCertificate(foreign)).toEqual({ ok: false, reason: 'unknown_issuer' });
    // Same issuer name, wrong key.
    const caCn = new X509Certificate(r.svc.caCertificate()!).subject
      .split('\n')
      .find((l) => l.startsWith('CN='))!
      .slice(3);
    const forged = buildCertificate({
      subject: { commonName: 'dev-2' },
      issuer: { commonName: caCn },
      publicKey: ed25519FromRaw(publicKey),
      signer: other.privateKey,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + DAY),
      keyUsage: 0x80,
    }).pem;
    expect(r.svc.verifyDeviceCertificate(forged).ok).toBe(false);
  });

  it('report expiry against the clock', async () => {
    const r = rig({ clock: true });
    const publicKey = rawEd25519(generateKeyPairSync('ed25519').publicKey).toString('base64url');
    const issued = (await r.svc.issueDeviceCertificate({
      deviceId: 'd1',
      publicKey,
      role: 'client',
    }))!;
    r.clock!.t = T0 + 366 * DAY;
    expect(r.svc.verifyDeviceCertificate(issued.certificatePem)).toEqual({
      ok: false,
      reason: 'expired',
    });
    r.clock!.t = T0 - 2 * DAY;
    expect(r.svc.verifyDeviceCertificate(issued.certificatePem)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
  });
});

/** A stand-in for the mesh's CA (a `tailscale cert` result). */
function meshIssuer() {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caPem = buildCertificate({
    subject: { commonName: 'Mesh test CA' },
    issuer: { commonName: 'Mesh test CA' },
    publicKey: ca.publicKey,
    signer: ca.privateKey,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    ca: { pathLength: 0 },
    keyUsage: 0x86,
  }).pem;
  const calls: string[] = [];
  return {
    caPem,
    calls,
    issue(host: string, days = 90, from = Date.now() - 3_600_000) {
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pem = buildCertificate({
        subject: { commonName: host },
        issuer: { commonName: 'Mesh test CA' },
        publicKey: leaf.publicKey,
        signer: ca.privateKey,
        notBefore: new Date(from),
        notAfter: new Date(from + days * DAY),
        keyUsage: 0x80,
        extKeyUsage: ['1.3.6.1.5.5.7.3.1'],
        altNames: { hosts: [host] },
      }).pem;
      return {
        certPem: pem,
        keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      };
    },
    source(days = 90) {
      return {
        request: (host: string) => {
          calls.push(host);
          const c = this.issue(host, days);
          return Promise.resolve({ ...c, notAfter: new Date(Date.now() + days * DAY) });
        },
      };
    },
  };
}

describe('mesh certificates', () => {
  const HOST = 'hub.tail1234.ts.net';

  it('need a mesh that can issue them', async () => {
    const r = rig({ mode: 'mesh' });
    await expect(r.svc.requestMeshCert(HOST)).rejects.toMatchObject({ code: 'capability_missing' });
    await expect(r.svc.requestMeshCert('10.0.0.1')).rejects.toMatchObject({ code: 'validation' });
    expect(await r.svc.tlsMaterial()).toBeNull();
    expect((await r.svc.summary()).problems.join(' ')).toContain('set up a mesh');
  });

  it('are stored and served for their host, by SNI next to the local CA leaf', async () => {
    const r = rig();
    const mesh = meshIssuer();
    r.svc.useMeshCerts(mesh.source());
    const view = await r.svc.requestMeshCert(HOST);
    expect(view).toMatchObject({ host: HOST, status: 'ok' });
    expect(mesh.calls).toEqual([HOST]);
    const material = (await r.svc.tlsMaterial())!;
    expect(material.sni.map((s) => s.host)).toEqual([HOST]);
    const viaMesh = await handshake(material, HOST, mesh.caPem);
    expect(viaMesh.result).toBe('ok');
    expect(viaMesh.peer).toBe(`DNS:${HOST}`);
    expect((await handshake(material, 'nova-hub.local', r.svc.caCertificate()!)).result).toBe('ok');
    // With meshCerts off, the local-CA mode serves the leaf only.
    r.settings.meshCerts = false;
    expect((await r.svc.tlsMaterial())!.sni).toEqual([]);
    expect((await r.svc.summary()).meshCert).toBeNull();
    // Mode mesh serves the mesh certificate by default.
    r.settings.mode = 'mesh';
    const meshOnly = (await r.svc.tlsMaterial())!;
    expect(new X509Certificate(meshOnly.cert).subjectAltName).toBe(`DNS:${HOST}`);
    expect((await r.svc.summary()).meshCert).toMatchObject({ host: HOST });
    expect(r.audit.map((a) => a.action)).toContain('trust.mesh.store');
  });

  it('are refused when they do not cover the host or do not match the key', async () => {
    const r = rig();
    const mesh = meshIssuer();
    const good = mesh.issue(HOST);
    const other = mesh.issue('other.tail1234.ts.net');
    await expect(r.svc.storeMeshCert(HOST, other.certPem, other.keyPem)).rejects.toThrow(
      'does not cover',
    );
    await expect(r.svc.storeMeshCert(HOST, good.certPem, other.keyPem)).rejects.toThrow(
      'does not match',
    );
    await expect(r.svc.storeMeshCert(HOST, 'junk', good.keyPem)).rejects.toThrow('unreadable');
    const old = mesh.issue(HOST, 1, Date.now() - 3 * DAY);
    await expect(r.svc.storeMeshCert(HOST, old.certPem, old.keyPem)).rejects.toThrow('expired');
  });

  it('are renewed at two thirds of their life and replace the previous one', async () => {
    const r = rig({ mode: 'mesh', clock: true });
    const mesh = meshIssuer();
    r.svc.useMeshCerts(mesh.source());
    r.clock!.t = Date.now();
    await r.svc.requestMeshCert(HOST);
    await r.svc.maintain();
    expect(mesh.calls).toEqual([HOST]);
    r.clock!.t = Date.now() + 61 * DAY;
    await r.svc.maintain();
    expect(mesh.calls).toEqual([HOST, HOST]);
    const rows = db.raw
      .prepare(
        "SELECT superseded_at FROM trust_certificate WHERE kind = 'mesh' ORDER BY created_at",
      )
      .all() as { superseded_at: string | null }[];
    expect(rows.map((x) => x.superseded_at === null)).toEqual([false, true]);
    // The superseded certificate's key left the vault.
    const keys = db.raw
      .prepare("SELECT key_ref FROM trust_certificate WHERE kind = 'mesh' ORDER BY created_at")
      .all() as { key_ref: string | null }[];
    expect(keys[0]!.key_ref).toBeNull();
    expect(await secrets.list('secret://hub/tls/mesh/')).toEqual([keys[1]!.key_ref]);
    // A failing renewal is a problem, not an exception.
    r.svc.useMeshCerts({ request: () => Promise.reject(new Error('mesh offline')) });
    r.clock!.t = Date.now() + 122 * DAY;
    await r.svc.maintain();
    expect((await r.svc.summary()).problems.join(' ')).toContain('mesh offline');
  });
});

describe('the signed identity statement', () => {
  it('lists the served certificates under a signature the pinned key verifies', async () => {
    const r = rig();
    await r.svc.start();
    await r.svc.ensureLeaf();
    const s = await r.svc.identityStatement(NONCE);
    expect(s.hubFingerprint).toBe(r.svc.identity.fingerprint);
    expect(hubFingerprint(Buffer.from(s.hubPublicKey, 'base64url'))).toBe(s.hubFingerprint);
    const { signature, ...unsigned } = s;
    expect(
      verify(
        null,
        Buffer.from(hubIdentityStatementBytes(unsigned)),
        ed25519FromRaw(s.hubPublicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    const ca = new X509Certificate(r.svc.caCertificate()!);
    expect(s.certificates[0]).toMatchObject({
      kind: 'ca',
      sha256: ca.fingerprint256.replaceAll(':', '').toLowerCase(),
    });
    expect(s.certificates.map((c) => c.kind)).toEqual(['ca', 'leaf']);
    expect(s.pinning).toBe('required');
    // A changed field breaks the signature.
    expect(
      verify(
        null,
        Buffer.from(hubIdentityStatementBytes({ ...unsigned, pinning: 'off' })),
        ed25519FromRaw(s.hubPublicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(false);
    r.settings.pinNativeShells = false;
    expect((await r.svc.identityStatement(NONCE)).pinning).toBe('off');
  });

  it('signs the client nonce, bounded to 16-64 base64url characters (finding 10)', async () => {
    const r = rig();
    const s = await r.svc.identityStatement(NONCE);
    expect(s.nonce).toBe(NONCE);
    const { signature, ...unsigned } = s;
    // The same statement under another nonce does not verify: an old one cannot be replayed.
    expect(
      verify(
        null,
        Buffer.from(hubIdentityStatementBytes({ ...unsigned, nonce: 'another-nonce-123456' })),
        ed25519FromRaw(s.hubPublicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(false);
    for (const bad of ['short', 'x'.repeat(65), 'has spaces in it!!', ''])
      await expect(r.svc.identityStatement(bad)).rejects.toMatchObject({ code: 'validation' });
    expect((await r.svc.identityStatement('a'.repeat(16))).nonce).toBe('a'.repeat(16));
    expect((await r.svc.identityStatement('b'.repeat(64))).nonce).toBe('b'.repeat(64));
  });
});

describe('the native-shell pinning check (finding 10)', () => {
  async function connect(r: Rig, servedMaterial?: TlsMaterial) {
    await r.svc.start();
    const material = servedMaterial ?? (await r.svc.tlsMaterial())!;
    const chain = material.cert
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .map((pem) => new X509Certificate(pem));
    const statement = await r.svc.identityStatement(NONCE);
    return { chain, statement, pin: r.svc.identity.fingerprint };
  }

  it('trusts the listed leaf, and a renewed leaf issued by the listed CA for the dialed host', async () => {
    const r = rig();
    const { chain, statement, pin } = await connect(r);
    expect(
      checkHubIdentity({ statement, pin, nonce: NONCE, host: 'nova-hub.local', chain }),
    ).toEqual({ result: 'trusted', via: 'listed' });
    // A leaf the statement does not list (issued after it) passes through the CA rule.
    const old = await r.svc.identityStatement(NONCE);
    const renewed = (await r.svc.ensureLeaf({ force: true })).cert_pem;
    const renewedChain = [new X509Certificate(renewed), chain[1]!];
    expect(
      checkHubIdentity({
        statement: old,
        pin,
        nonce: NONCE,
        host: '192.168.1.20',
        chain: renewedChain,
      }),
    ).toEqual({ result: 'trusted', via: 'ca' });
    expect(
      checkHubIdentity({
        statement: old,
        pin,
        nonce: NONCE,
        host: 'other.local',
        chain: renewedChain,
      }),
    ).toEqual({ result: 'refused', reason: 'host_mismatch' });
  });

  it('never accepts a device certificate, revoked or not', async () => {
    const r = rig();
    const { chain, statement, pin } = await connect(r);
    const device = generateKeyPairSync('ed25519');
    const issued = (await r.svc.issueDeviceCertificate({
      deviceId: 'dev-1',
      publicKey: rawEd25519(device.publicKey).toString('base64url'),
      role: 'client',
    }))!;
    const deviceChain = [new X509Certificate(issued.certificatePem), chain[1]!];
    for (const host of ['dev-1', 'nova-hub.local', '192.168.1.20'])
      expect(checkHubIdentity({ statement, pin, nonce: NONCE, host, chain: deviceChain })).toEqual({
        result: 'refused',
        reason: 'not_server_certificate',
      });
    await r.svc.revokeDevice('dev-1');
    expect(
      checkHubIdentity({ statement, pin, nonce: NONCE, host: 'dev-1', chain: deviceChain }).result,
    ).toBe('refused');
    // Nor the CA itself.
    expect(
      checkHubIdentity({
        statement,
        pin,
        nonce: NONCE,
        host: 'nova-hub.local',
        chain: [chain[1]!, chain[1]!],
      }),
    ).toEqual({ result: 'refused', reason: 'not_server_certificate' });
  });

  it('refuses a replayed, forged or foreign statement and an unknown certificate', async () => {
    const r = rig();
    const { chain, statement, pin } = await connect(r);
    const base = { pin, nonce: NONCE, host: 'nova-hub.local', chain };
    expect(checkHubIdentity({ ...base, statement, nonce: 'a-fresh-nonce-0000' })).toEqual({
      result: 'refused',
      reason: 'nonce_mismatch',
    });
    expect(checkHubIdentity({ ...base, statement: { ...statement, pinning: 'off' } })).toEqual({
      result: 'refused',
      reason: 'bad_signature',
    });
    expect(checkHubIdentity({ ...base, statement, pin: 'x'.repeat(43) })).toEqual({
      result: 'refused',
      reason: 'pin_mismatch',
    });
    expect(checkHubIdentity({ ...base, statement, chain: [] })).toEqual({
      result: 'refused',
      reason: 'no_certificate',
    });
    // Any other CA's server certificate for the right name.
    const mesh = meshIssuer();
    const stranger = new X509Certificate(mesh.issue('nova-hub.local').certPem);
    expect(
      checkHubIdentity({ ...base, statement, chain: [stranger, new X509Certificate(mesh.caPem)] }),
    ).toEqual({ result: 'refused', reason: 'not_listed' });
    // An expired listed leaf.
    expect(checkHubIdentity({ ...base, statement, now: new Date(Date.now() + 400 * DAY) })).toEqual(
      {
        result: 'refused',
        reason: 'expired',
      },
    );
    // The owner turned pinning off (signed): the platform roots decide.
    r.settings.pinNativeShells = false;
    const off = await r.svc.identityStatement(NONCE);
    expect(checkHubIdentity({ ...base, statement: off })).toEqual({ result: 'use_platform_roots' });
  });
});
