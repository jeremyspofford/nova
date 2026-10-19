// The compute node's TLS client (FR-126, FR-134; docs/22 §5): against a scripted HTTPS Hub that
// asks for client certificates, it trusts the Hub through the signed identity statement checked on
// the connection itself and caches the CA, presents its device certificate only to a verified Hub,
// refuses another CA's certificate (even with the real statement relayed), another identity and a
// replayed statement, enrolls and heartbeats over mutual TLS, names a revoked certificate, learns
// the CA over plain HTTP and moves from http:// to https:// once the Hub serves it.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubIdentityStatementBytes, type HubIdentityStatement } from '@nova/shared';
import { Logger, MemorySink } from '@nova/telemetry';
// The Hub's own certificate builder makes the test CA, leaves and device certificates.
import { buildCertificate } from '../../../packages/core/src/trust/x509.ts';
import {
  ComputeNode,
  HubClient,
  nameConstraintsAllow,
  HubError,
  HubTls,
  checkStatement,
  enroll,
  generateKeys,
  learnCaOverHttp,
  loadState,
  saveState,
  startFakeBackend,
  type FakeBackend,
  type HubTrust,
  type NodeKeys,
} from '../src/index.ts';

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const DAY = 86_400_000;
const TOKEN = `nve_${'t'.repeat(43)}`;

interface Ca {
  name: string;
  key: KeyObject;
  pem: string;
  x: X509Certificate;
}

function makeCa(name: string, nameConstraints?: { dns: string[]; ip: string[] }): Ca {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const c = buildCertificate({
    subject: { commonName: name },
    issuer: { commonName: name },
    publicKey,
    signer: privateKey,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    ca: { pathLength: 0 },
    keyUsage: 0x06,
    ...(nameConstraints ? { nameConstraints } : {}),
  });
  return { name, key: privateKey, pem: c.pem, x: new X509Certificate(c.pem) };
}

function leafOf(ca: Ca, hosts: string[], days = 30): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const c = buildCertificate({
    subject: { commonName: hosts[0]! },
    issuer: { commonName: ca.name },
    publicKey,
    signer: ca.key,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + days * DAY),
    keyUsage: 0x80,
    extKeyUsage: [SERVER_AUTH],
    altNames: { hosts },
  });
  return { cert: c.pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

function deviceCert(ca: Ca, id: string, keys: NodeKeys): string {
  return buildCertificate({
    subject: { commonName: id, organizationalUnit: 'compute' },
    issuer: { commonName: ca.name },
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: keys.publicKey },
      format: 'jwk',
    }),
    signer: ca.key,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    keyUsage: 0x80,
    extKeyUsage: [CLIENT_AUTH],
    altNames: { uris: [`urn:nova:device:${id}`] },
  }).pem;
}

const identity = generateKeyPairSync('ed25519');
const identityRaw = (identity.publicKey.export({ format: 'jwk' }) as { x: string }).x;
const PIN = createHash('sha256').update(Buffer.from(identityRaw, 'base64url')).digest('base64url');
const sha = (pem: string) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');

function statementFor(
  nonce: string,
  certs: { kind: 'ca' | 'leaf' | 'mesh'; pem: string }[],
  key: KeyObject = identity.privateKey,
  raw = identityRaw,
): HubIdentityStatement {
  const fp = createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url');
  const unsigned = {
    v: 1 as const,
    nonce,
    hubFingerprint: fp,
    hubPublicKey: raw,
    pinning: 'required' as const,
    certificates: certs.map((c) => ({
      kind: c.kind,
      sha256: sha(c.pem),
      notAfter: new X509Certificate(c.pem).validTo,
    })),
    issuedAt: new Date().toISOString(),
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(hubIdentityStatementBytes(unsigned)), key).toString(
      'base64url',
    ),
  };
}

interface TestHub {
  url: string;
  port: number;
  statements: number;
  /** Per request path: whether a client certificate of the CA came with it. */
  calls: { path: string; cert: boolean }[];
  /** Handshakes in which the client presented a certificate at all. */
  presented: number;
  revoked: boolean;
  close(): Promise<void>;
}

async function testHub(opts: {
  ca: Ca;
  chain: string;
  key: string;
  statement: (nonce: string) => HubIdentityStatement;
  /** Cap the protocol (an impostor offering TLS 1.2, where client certificates go out early). */
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
}): Promise<TestHub> {
  const hub: TestHub = {
    url: '',
    port: 0,
    statements: 0,
    calls: [],
    presented: 0,
    revoked: false,
    close: () => Promise.resolve(),
  };
  const server: Server = createServer(
    {
      cert: opts.chain,
      key: opts.key,
      requestCert: true,
      rejectUnauthorized: false,
      ca: opts.ca.pem,
      ...(opts.maxVersion ? { maxVersion: opts.maxVersion } : {}),
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const url = new URL(req.url ?? '/', 'https://hub');
      const peer = (req.socket as TLSSocket).getPeerX509Certificate();
      const cert = Boolean(peer?.checkIssued(opts.ca.x));
      if (url.pathname === '/api/v1/trust/identity') {
        hub.statements++;
        // The provisional connection names nobody: a certificate here would be a leak.
        if (cert) hub.calls.push({ path: url.pathname, cert });
        return send(200, opts.statement(url.searchParams.get('nonce') ?? ''));
      }
      hub.calls.push({ path: url.pathname, cert });
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        if (url.pathname === '/api/v1/hello') return send(200, { name: 'nova-hub' });
        if (hub.revoked)
          return send(403, {
            error: {
              code: 'policy_denied',
              message: 'refused',
              details: { reason: 'certificate_revoked' },
            },
          });
        if (url.pathname === '/node/v1/register')
          return send(201, {
            nodeId: 'node-1',
            credential: 'nvn_cred',
            heartbeatIntervalMs: 10_000,
            protocolVersion: 1,
          });
        return send(200, { ok: true, body: raw.length });
      });
    },
  );
  server.on('secureConnection', (s: TLSSocket) => {
    if (s.getPeerX509Certificate()) hub.presented++;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hub.port = (server.address() as { port: number }).port;
  hub.url = `https://127.0.0.1:${hub.port}`;
  hub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return hub;
}

let dir: string;
let ca: Ca;
let leaf: { cert: string; key: string };
let hub: TestHub;
let backend: FakeBackend;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-compute-tls-'));
  ca = makeCa('Nova Hub CA');
  leaf = leafOf(ca, ['127.0.0.1', 'localhost']);
  hub = await testHub({
    ca,
    chain: `${leaf.cert}${ca.pem}`,
    key: leaf.key,
    statement: (n) =>
      statementFor(n, [
        { kind: 'ca', pem: ca.pem },
        { kind: 'leaf', pem: leaf.cert },
      ]),
  });
  backend = await startFakeBackend({ models: ['llama3'] });
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await hub.close();
  await backend.close();
  rmSync(dir, { recursive: true, force: true });
});

const pinned = (): HubTrust => ({ pin: PIN, caPem: null, listed: [] });

describe('trusting an https:// Hub (docs/22 §5)', () => {
  it('checks the signed statement on the connection, caches the CA, then needs none', async () => {
    const learned: HubTrust[] = [];
    const tls = new HubTls({ trust: pinned(), onTrust: (t) => learned.push(t) });
    const client = new HubClient({ hubUrl: hub.url, fetch: tls.fetch() });
    expect(await client.hello()).toEqual({ name: 'nova-hub' });
    expect(hub.statements).toBe(1);
    expect(learned[0]?.caPem && new X509Certificate(learned[0].caPem).fingerprint256).toBe(
      ca.x.fingerprint256,
    );
    expect(learned[0]?.listed.map((l) => l.sha256)).toEqual([sha(leaf.cert)]);
    await client.hello();
    expect(hub.statements).toBe(1);
    // A renewed leaf of the same CA is trusted through the cached CA alone.
    const only = new HubTls({ trust: { ...learned[0]!, listed: [] } });
    await new HubClient({ hubUrl: hub.url, fetch: only.fetch() }).hello();
    expect(hub.statements).toBe(1);
  });

  it('refuses another CA, another identity, a replayed statement, or no pin', async () => {
    const other = makeCa('Someone else');
    const fake = leafOf(other, ['127.0.0.1']);
    const mitm = await testHub({
      ca: other,
      chain: `${fake.cert}${other.pem}`,
      key: fake.key,
      // The party in the middle relays the real Hub's signed statement.
      statement: (n) =>
        statementFor(n, [
          { kind: 'ca', pem: ca.pem },
          { kind: 'leaf', pem: leaf.cert },
        ]),
    });
    closers.push(() => mitm.close());
    const attempt = (h: TestHub, trust: HubTrust) =>
      new HubClient({ hubUrl: h.url, fetch: new HubTls({ trust }).fetch() }).hello();
    await expect(attempt(mitm, pinned())).rejects.toThrow(/not your Hub.*not_listed/);
    await expect(
      attempt(mitm, {
        pin: PIN,
        caPem: ca.pem,
        listed: [{ sha256: sha(leaf.cert), notAfter: '2099-01-01T00:00:00Z' }],
      }),
    ).rejects.toThrow(/not_listed/);
    const stranger = generateKeyPairSync('ed25519');
    const strangerRaw = (stranger.publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const imposter = await testHub({
      ca,
      chain: `${leaf.cert}${ca.pem}`,
      key: leaf.key,
      statement: (n) =>
        statementFor(n, [{ kind: 'ca', pem: ca.pem }], stranger.privateKey, strangerRaw),
    });
    closers.push(() => imposter.close());
    await expect(attempt(imposter, pinned())).rejects.toThrow(/pin_mismatch/);
    const replay = await testHub({
      ca,
      chain: `${leaf.cert}${ca.pem}`,
      key: leaf.key,
      statement: () => statementFor('a-nonce-from-yesterday', [{ kind: 'ca', pem: ca.pem }]),
    });
    closers.push(() => replay.close());
    await expect(attempt(replay, pinned())).rejects.toThrow(/nonce_mismatch/);
    await expect(attempt(hub, { pin: null, caPem: null, listed: [] })).rejects.toThrow(
      /no Hub fingerprint is pinned/,
    );
  });

  it('holds the Hub CA to its name constraints, as novad does', async () => {
    // Like the Hub local CA: local names and private ranges only (docs/22 §5).
    const limited = makeCa('Nova Hub CA', {
      dns: ['local', 'localhost'],
      ip: ['127.0.0.0/8', '10.0.0.0/8'],
    });
    const inside = leafOf(limited, ['127.0.0.1', 'hub.local']);
    const outside = leafOf(limited, ['127.0.0.1', 'bank.example.com']);
    const farIp = leafOf(limited, ['192.0.2.7']);
    const x = (pem: string) => new X509Certificate(pem);
    expect(nameConstraintsAllow(limited.x, x(inside.cert))).toBe(true);
    expect(nameConstraintsAllow(limited.x, x(outside.cert))).toBe(false);
    expect(nameConstraintsAllow(limited.x, x(farIp.cert))).toBe(false);
    // A CA without constraints allows its leaves.
    expect(nameConstraintsAllow(ca.x, x(leaf.cert))).toBe(true);
    const s = statementFor('n', [{ kind: 'ca', pem: limited.pem }]);
    const check = (l: { cert: string }, host: string) =>
      checkStatement({ statement: s, pin: PIN, nonce: 'n', host, chain: [x(l.cert), limited.x] });
    expect(check(inside, '127.0.0.1')).toMatchObject({ ok: true });
    // Dialed at a name inside the constraints, but the leaf also claims one outside: refused.
    expect(check(outside, '127.0.0.1')).toEqual({ ok: false, reason: 'not_listed' });
    expect(check(farIp, '192.0.2.7')).toEqual({ ok: false, reason: 'not_listed' });
    // The same through a live connection: the cached CA does not vouch, nor does the statement.
    const hubOutside = await testHub({
      ca: limited,
      chain: `${outside.cert}${limited.pem}`,
      key: outside.key,
      statement: (n) => statementFor(n, [{ kind: 'ca', pem: limited.pem }]),
    });
    closers.push(() => hubOutside.close());
    const cached = new HubTls({ trust: { pin: PIN, caPem: limited.pem, listed: [] } });
    await expect(
      new HubClient({ hubUrl: hubOutside.url, fetch: cached.fetch() }).hello(),
    ).rejects.toThrow(/not your Hub.*not_listed/);
    expect(hubOutside.calls).toEqual([]);
  });

  it('checks chains like the Hub reference', () => {
    const s = statementFor('n', [{ kind: 'ca', pem: ca.pem }]);
    const chain = [new X509Certificate(leaf.cert), ca.x];
    const check = (host: string, c = chain, now?: number) =>
      checkStatement({
        statement: s,
        pin: PIN,
        nonce: 'n',
        host,
        chain: c,
        ...(now ? { now } : {}),
      });
    expect(check('127.0.0.1')).toMatchObject({ ok: true });
    expect(check('[::1]')).toEqual({ ok: false, reason: 'host_mismatch' });
    expect(check('127.0.0.1', chain, Date.now() + 400 * DAY)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(check('127.0.0.1', [chain[0]!])).toEqual({ ok: false, reason: 'not_listed' });
    expect(check('127.0.0.1', [])).toEqual({ ok: false, reason: 'no_certificate' });
    const keys = generateKeys();
    const dev = new X509Certificate(deviceCert(ca, 'dev-1', keys));
    expect(check('127.0.0.1', [dev, ca.x])).toEqual({
      ok: false,
      reason: 'not_server_certificate',
    });
    expect(
      checkStatement({
        statement: { ...s, pinning: 'off' },
        pin: PIN,
        nonce: 'n',
        host: 'x',
        chain,
      }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(
      checkStatement({
        statement: { ...s, hubPublicKey: 'short' },
        pin: PIN,
        nonce: 'n',
        host: 'x',
        chain,
      }),
    ).toEqual({
      ok: false,
      reason: 'pin_mismatch',
    });
    const listed = statementFor('n', [{ kind: 'leaf', pem: leaf.cert }]);
    expect(
      checkStatement({
        statement: listed,
        pin: PIN,
        nonce: 'n',
        host: 'anything',
        chain: [chain[0]!],
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('mutual TLS for the node (FR-126)', () => {
  it('never shows its certificate to a server the cached trust does not vouch for', async () => {
    const keys = generateKeys();
    const client = { certPem: deviceCert(ca, 'node-1', keys), keyPem: keys.privateKeyPem };
    const real = (n: string) =>
      statementFor(n, [
        { kind: 'ca', pem: ca.pem },
        { kind: 'leaf', pem: leaf.cert },
      ]);
    // Another CA's certificate, and a certificate of the Hub's own CA for another host (its
    // chain passes the handshake; the cached trust refuses it before the last flight).
    const other = makeCa('Someone else');
    const foreign = leafOf(other, ['127.0.0.1']);
    const misnamed = leafOf(ca, ['elsewhere.local']);
    const impostors: TestHub[] = [];
    for (const maxVersion of ['TLSv1.2', 'TLSv1.3'] as const) {
      const f = `${foreign.cert}${other.pem}`;
      const m = `${misnamed.cert}${ca.pem}`;
      impostors.push(
        await testHub({ ca, chain: f, key: foreign.key, statement: real, maxVersion }),
        await testHub({ ca, chain: m, key: misnamed.key, statement: real, maxVersion }),
      );
    }
    for (const h of impostors) closers.push(() => h.close());
    for (const trust of [
      { pin: PIN, caPem: ca.pem, listed: [] },
      {
        pin: PIN,
        caPem: null,
        listed: [{ sha256: sha(leaf.cert), notAfter: '2099-01-01T00:00:00Z' }],
      },
    ]) {
      for (const h of impostors) {
        for (let i = 0; i < 3; i++) {
          const tls = new HubTls({ trust, client });
          await expect(
            new HubClient({ hubUrl: h.url, fetch: tls.fetch() }).hello(),
          ).rejects.toThrow(/not your Hub/);
        }
      }
    }
    expect(impostors.map((h) => h.presented)).toEqual([0, 0, 0, 0]);
    expect(impostors.map((h) => h.calls)).toEqual([[], [], [], []]);
    // The real Hub gets it, over TLS 1.3.
    const tls = new HubTls({ trust: { pin: PIN, caPem: ca.pem, listed: [] }, client });
    const s = await tls.connect('127.0.0.1', hub.port);
    expect(s.getProtocol()).toBe('TLSv1.3');
    const answer = await new Promise<string>((resolve) => {
      let got = '';
      s.on('data', (c: Buffer) => (got += c.toString()));
      s.on('end', () => resolve(got));
      s.write(`GET /api/v1/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    expect(answer).toContain('nova-hub');
    expect(hub.presented).toBe(1);
    expect(hub.calls).toEqual([{ path: '/api/v1/hello', cert: true }]);
  });

  it('enrolls and heartbeats presenting its certificate only to the verified Hub', async () => {
    const keys = generateKeys();
    const cert = deviceCert(ca, 'node-1', keys);
    const state = await enroll({
      hubUrl: hub.url,
      token: TOKEN,
      backendUrl: backend.url,
      listen: '127.0.0.1:0',
      advertise: 'http://127.0.0.1:7420',
      dataDir: dir,
      keys,
      pin: PIN,
      certificatePem: cert,
    });
    expect(state.enrollment?.certificatePem).toBe(cert);
    expect(state.hubTrust?.caPem && new X509Certificate(state.hubTrust.caPem).fingerprint256).toBe(
      ca.x.fingerprint256,
    );
    // The provisional connection carried only the statement; the registration came with the cert.
    expect(hub.calls).toEqual([{ path: '/node/v1/register', cert: true }]);
    const logs = new MemorySink();
    const node = await ComputeNode.start({
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0 },
      log: new Logger({ module: 'test', sinks: [logs] }),
    });
    closers.push(() => node.stop());
    expect(hub.calls.filter((c) => c.path === '/node/v1/heartbeat')).toEqual([
      { path: '/node/v1/heartbeat', cert: true },
    ]);
    expect(hub.statements).toBe(1);
    // The Hub refuses the certificate: said in the log, the node keeps its credentials.
    hub.revoked = true;
    await node.beat();
    expect(JSON.stringify(logs.records)).toContain('certificate_revoked');
    expect(loadState(dir)?.enrollment).not.toBeNull();
    const err = await new HubClient({
      hubUrl: hub.url,
      fetch: new HubTls({ trust: state.hubTrust! }).fetch(),
    })
      .heartbeat('nvn_cred', { load: { running: 0, queued: 0 }, models: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).reason).toBe('certificate_revoked');
  });

  it('learns the CA over plain HTTP and moves to https:// when the Hub serves it', async () => {
    const plain = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://hub');
      res.writeHead(200, {
        'content-type': url.pathname.endsWith('.pem')
          ? 'application/x-pem-file'
          : 'application/json',
      });
      if (url.pathname === '/api/v1/trust/identity')
        return res.end(
          JSON.stringify(
            statementFor(url.searchParams.get('nonce') ?? '', [{ kind: 'ca', pem: ca.pem }]),
          ),
        );
      if (url.pathname === '/api/v1/trust/ca.pem') return res.end(ca.pem);
      res.end('{}');
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => plain.close(() => r())));
    const plainUrl = `http://127.0.0.1:${(plain.address() as { port: number }).port}`;
    const learned = await learnCaOverHttp(plainUrl, pinned(), (...a) => fetch(...a));
    expect(learned.caPem && new X509Certificate(learned.caPem).fingerprint256).toBe(
      ca.x.fingerprint256,
    );
    await expect(
      learnCaOverHttp(plainUrl, { ...pinned(), pin: 'x'.repeat(43) }, (...a) => fetch(...a)),
    ).rejects.toThrow(/pin_mismatch/);
    // A node enrolled over http:// whose Hub now serves HTTPS on the same address.
    const keys = generateKeys();
    saveState(dir, {
      version: 1,
      deviceId: 'dev',
      name: 'gpu',
      hubUrl: `http://127.0.0.1:${hub.port}`,
      backend: { url: backend.url, kind: 'openai_compatible' },
      listen: { host: '127.0.0.1', port: 0 },
      endpoint: 'http://127.0.0.1:7420',
      maxConcurrentJobs: 1,
      maxQueue: 4,
      enrollment: {
        nodeId: 'node-1',
        credential: 'nvn_cred',
        jobToken: `nvj_${'j'.repeat(43)}`,
        privateKeyPem: keys.privateKeyPem,
        publicKey: keys.publicKey,
        heartbeatIntervalMs: 10_000,
        protocolVersion: 1,
        enrolledAt: new Date().toISOString(),
        certificatePem: deviceCert(ca, 'node-1', keys),
      },
      revokedAt: null,
      hubTrust: learned,
    });
    const node = await ComputeNode.start({
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0 },
      log: new Logger({ module: 'test', sinks: [] }),
    });
    closers.push(() => node.stop());
    expect(node.hubUrl).toBe(hub.url);
    expect(loadState(dir)?.hubUrl).toBe(hub.url);
    await node.beat();
    expect(hub.calls.at(-1)).toEqual({ path: '/node/v1/heartbeat', cert: true });
  });
});
