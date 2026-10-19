// The connect flow against real servers on loopback (docs/22 §5): TLS with the Hub's chain, the
// identity route answered on the same connection, and plain HTTP for this computer only.
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectHub,
  normalizeHubUrl,
  normalizePin,
  parseConnectInput,
  refusalMessage,
  verifyHub,
  type ConnectRefusal,
} from '../src/connect.ts';
import { isLoopbackHost, probeIdentity } from '../src/probe.ts';
import { listed, makeIdentity, makePki, statement } from './fixtures.ts';

const pki = makePki(['127.0.0.1', 'localhost']);
const id = makeIdentity();

type Answer = (nonce: string) => { status: number; body: unknown };
let answer: Answer = (nonce) => ({ status: 200, body: statement(id, nonce, listed(pki)) });
const seen: { url: string; headers: IncomingMessage['headers'] }[] = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ url: req.url ?? '', headers: req.headers });
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname !== '/api/v1/trust/identity') {
    res.writeHead(404).end();
    return;
  }
  const a = answer(u.searchParams.get('nonce') ?? '');
  res.writeHead(a.status, { 'content-type': 'application/json' });
  res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
}

let tls: Server;
let plain: Server;
let tlsUrl = '';
let plainUrl = '';

beforeAll(async () => {
  tls = createHttps({ cert: `${pki.leafPem}${pki.caPem}`, key: pki.leafKeyPem }, handler);
  plain = createHttp(handler);
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
  tlsUrl = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
  plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => tls.close(r));
  await new Promise((r) => plain.close(r));
});

const reset = () => {
  answer = (nonce) => ({ status: 200, body: statement(id, nonce, listed(pki)) });
  seen.length = 0;
};

describe('probeIdentity', () => {
  it('reads the statement and the chain on one connection and sends no credential', async () => {
    reset();
    const p = await probeIdentity(tlsUrl, 'bm9uY2Utbm9uY2Utbm9uY2Ut', { ca: [pki.caPem] });
    expect(p.status).toBe(200);
    expect(p.chain).toHaveLength(2);
    expect(p.platformTrusted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/api/v1/trust/identity?nonce=bm9uY2Utbm9uY2Utbm9uY2Ut');
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('reports a chain the platform does not trust', async () => {
    reset();
    const p = await probeIdentity(tlsUrl, 'bm9uY2Utbm9uY2Utbm9uY2Ut');
    expect(p.platformTrusted).toBe(false);
  });

  it('never uses plain HTTP off this computer, and gives up on a silent server', async () => {
    await expect(probeIdentity('http://192.0.2.1:9', 'x'.repeat(20))).rejects.toThrow(/plain HTTP/);
    await expect(probeIdentity('ftp://127.0.0.1', 'x'.repeat(20))).rejects.toThrow(/http/);
    const silent = createHttp(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    await expect(
      probeIdentity(`http://127.0.0.1:${port}`, 'x'.repeat(20), { timeoutMs: 200 }),
    ).rejects.toThrow(/no answer/);
    silent.closeAllConnections();
    await new Promise((r) => silent.close(r));
  });

  it('keeps non-JSON answers as null', async () => {
    reset();
    answer = () => ({ status: 200, body: 'not json' });
    const p = await probeIdentity(plainUrl, 'x'.repeat(20));
    expect(p.body).toBeNull();
  });

  it('knows which addresses are this computer', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.5')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.2')).toBe(false);
    expect(isLoopbackHost('127.example')).toBe(false);
  });
});

describe('verifyHub', () => {
  it('trusts the Hub over TLS with the pinned key', async () => {
    reset();
    const res = await verifyHub(tlsUrl, id.fingerprint);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.trust.kind).toBe('pinned');
      expect(res.origin).toBe(tlsUrl);
    }
  });

  it('trusts a Hub on this computer over plain HTTP after the statement check', async () => {
    reset();
    const res = await verifyHub(plainUrl, id.fingerprint);
    expect(res).toMatchObject({ ok: true, trust: { kind: 'loopback-http', host: '127.0.0.1' } });
  });

  const refusals: [string, ConnectRefusal, () => void, string?][] = [
    ['another identity', 'pin_mismatch', () => undefined, makeIdentity().fingerprint],
    [
      'a replayed statement',
      'nonce_mismatch',
      () =>
        (answer = () => ({
          status: 200,
          body: statement(id, 'b2xkLW9sZC1vbGQtb2xk', listed(pki)),
        })),
    ],
    [
      'a missing identity key',
      'identity_unavailable',
      () => (answer = () => ({ status: 409, body: {} })),
    ],
    [
      'a server that is not a Hub',
      'bad_response',
      () => (answer = () => ({ status: 404, body: {} })),
    ],
    [
      'a body that is not a statement',
      'bad_response',
      () => (answer = () => ({ status: 200, body: { v: 2 } })),
    ],
    [
      'a certificate the statement does not vouch for',
      'not_listed',
      () => (answer = (n) => ({ status: 200, body: statement(id, n, []) })),
    ],
  ];
  for (const [what, reason, arrange, pin] of refusals) {
    it(`refuses ${what} (${reason}) and says nothing was sent`, async () => {
      reset();
      arrange();
      const res = await verifyHub(tlsUrl, pin ?? id.fingerprint);
      expect(res).toMatchObject({ ok: false, reason });
      if (!res.ok && reason !== 'identity_unavailable')
        expect(res.message).toContain('Nothing was sent');
    });
  }

  it('refuses plain HTTP to another computer before connecting', async () => {
    const res = await verifyHub('http://192.0.2.1:7443', id.fingerprint);
    expect(res).toMatchObject({ ok: false, reason: 'insecure_transport' });
  });

  it('reports an unreachable Hub', async () => {
    const res = await verifyHub('https://127.0.0.1:1', id.fingerprint);
    expect(res).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('defers to the platform roots when pinning is off, and refuses an untrusted chain then', async () => {
    reset();
    answer = (n) => ({ status: 200, body: statement(id, n, listed(pki), { pinning: 'off' }) });
    const trusted = await verifyHub(tlsUrl, id.fingerprint, {
      probe: (o, n) => probeIdentity(o, n, { ca: [pki.caPem] }),
    });
    expect(trusted).toMatchObject({ ok: true, trust: { kind: 'platform' } });
    const untrusted = await verifyHub(tlsUrl, id.fingerprint);
    expect(untrusted).toMatchObject({ ok: false, reason: 'untrusted_certificate' });
  });

  it('refuses a plain-HTTP statement for another key', async () => {
    reset();
    const res = await verifyHub(plainUrl, makeIdentity().fingerprint);
    expect(res).toMatchObject({ ok: false, reason: 'pin_mismatch' });
  });

  it('sends a fresh nonce of at least 128 bits each time', async () => {
    reset();
    await verifyHub(tlsUrl, id.fingerprint);
    await verifyHub(tlsUrl, id.fingerprint);
    const nonces = seen.map((s) => new URL(s.url, 'http://x').searchParams.get('nonce') ?? '');
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const n of nonces) expect(Buffer.from(n, 'base64url').length).toBeGreaterThanOrEqual(16);
  });
});

describe('connectHub', () => {
  it('moves on to the next address only when one is unreachable', async () => {
    reset();
    const res = await connectHub({
      origins: ['https://127.0.0.1:1', tlsUrl],
      pin: id.fingerprint,
      joinPath: '/add-device?p=x#c=ABCD-EFGH',
    });
    expect(res).toMatchObject({
      ok: true,
      origin: tlsUrl,
      joinPath: '/add-device?p=x#c=ABCD-EFGH',
    });
  });

  it('stops at a wrong identity', async () => {
    reset();
    const calls: string[] = [];
    const res = await connectHub(
      { origins: [tlsUrl, plainUrl], pin: makeIdentity().fingerprint, joinPath: null },
      {
        probe: (o, n) => {
          calls.push(o);
          return probeIdentity(o, n);
        },
      },
    );
    expect(res).toMatchObject({ ok: false, reason: 'pin_mismatch' });
    expect(calls).toEqual([tlsUrl]);
  });

  it('reports the first unreachable address when none answers', async () => {
    const res = await connectHub({
      origins: ['https://127.0.0.1:1', 'https://127.0.0.1:2'],
      pin: id.fingerprint,
      joinPath: null,
    });
    expect(res).toMatchObject({ ok: false, reason: 'unreachable', origin: 'https://127.0.0.1:1' });
    expect(await connectHub({ origins: [], pin: id.fingerprint, joinPath: null })).toMatchObject({
      ok: false,
      reason: 'invalid_input',
    });
  });
});

describe('parseConnectInput', () => {
  const pin = makeIdentity().fingerprint;

  it('takes the Hub, its other addresses, the pin and the join page from a native link', () => {
    const link = `nova://add-device?h=${encodeURIComponent('https://hub.local:7443')}&p=pair1&fp=${pin}&e=${encodeURIComponent('https://100.64.0.2:7443')}#c=ABCD-EFGH`;
    expect(parseConnectInput({ link })).toEqual({
      origins: ['https://hub.local:7443', 'https://100.64.0.2:7443'],
      pin,
      joinPath: `/add-device?p=pair1&fp=${pin}#c=ABCD-EFGH`,
    });
  });

  it("takes the Hub's QR link too", () => {
    const res = parseConnectInput({
      link: `https://hub.local:7443/add-device?p=pair1&fp=${pin}#c=ABCD-EFGH`,
    });
    expect(res).toMatchObject({ origins: ['https://hub.local:7443'], pin });
  });

  it('refuses links it cannot verify against', () => {
    const noPin = parseConnectInput({
      link: 'nova://add-device?h=https%3A%2F%2Fhub.local&p=pair1#c=ABCD-EFGH',
    });
    expect(noPin).toMatchObject({ ok: false, reason: 'invalid_input' });
    if ('ok' in noPin) expect(noPin.message).toMatch(/no Hub fingerprint/);
    expect(parseConnectInput({ link: `nova://add-device?p=pair1&fp=${pin}` })).toMatchObject({
      ok: false,
    });
    expect(parseConnectInput({ link: 'nova://chat/abc' })).toMatchObject({ ok: false });
    expect(parseConnectInput({ link: 'https://hub.local/chat' })).toMatchObject({ ok: false });
    expect(parseConnectInput({ link: 'https://[bad' })).toMatchObject({ ok: false });
  });

  it('takes a typed address and fingerprint', () => {
    expect(
      parseConnectInput({ url: 'hub.local:7443', pin: ` ${pin.slice(0, 20)} ${pin.slice(20)} ` }),
    ).toEqual({
      origins: ['https://hub.local:7443'],
      pin,
      joinPath: null,
    });
    expect(parseConnectInput({ url: '', pin })).toMatchObject({ ok: false });
    expect(parseConnectInput({ url: 'https://hub.local', pin: 'short' })).toMatchObject({
      ok: false,
    });
  });

  it('normalizes addresses and pins', () => {
    expect(normalizeHubUrl('https://user:pw@hub.local')).toBeNull();
    expect(normalizeHubUrl('ftp://hub.local')).toBeNull();
    expect(normalizeHubUrl('http://127.0.0.1:7443/chat?x=1')).toBe('http://127.0.0.1:7443');
    expect(normalizePin('x')).toBeNull();
  });

  it('has a sentence for every refusal', () => {
    const reasons: ConnectRefusal[] = [
      'invalid_input',
      'insecure_transport',
      'unreachable',
      'identity_unavailable',
      'bad_response',
      'untrusted_certificate',
      'pin_mismatch',
      'bad_signature',
      'nonce_mismatch',
      'no_certificate',
      'not_listed',
      'not_server_certificate',
      'host_mismatch',
      'expired',
    ];
    for (const r of reasons)
      expect(refusalMessage(r, 'https://hub.local').length).toBeGreaterThan(20);
  });
});
