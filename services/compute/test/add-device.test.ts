// Joining a Hub with a pairing code, Add Device v2 (FR-132, review finding 1): the code's canonical
// form, the commitment and confirmation as the Hub's fixed vectors, the signed reveal and status
// polls, and the flow against a scripted Hub: commit, reveal, a pinned Hub key whose signature
// must verify, approval, then registration with the granted token and the same key. A Hub that
// computes another confirmation, a key that does not hash to the pin, a missing or bad Hub
// signature, a denial, an expiry, a busy Hub and nobody approving in time all stop it.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDeviceCommitment,
  addDeviceConfirmation,
  formatConfirmation,
  generateKeys,
  hubKeyFingerprint,
  joinWithCode,
  loadState,
  normalizeAddDeviceCode,
  signAddDeviceReveal,
  signAddDeviceStatus,
  startFakeBackend,
  verifyHubReveal,
  type FakeBackend,
  type RegisterBody,
} from '../src/index.ts';

const PAIRING = '01920000-0000-7000-8000-00000000aaaa';
const HUB_NONCE = 'h'.repeat(43);

interface ScriptedHub {
  url: string;
  publicKey: string;
  fingerprint: string;
  /** Hello without an identity (null fields) and an unsigned reveal. */
  noIdentity: boolean;
  /** Sign the reveal with another key, or not at all. */
  signature: 'good' | 'other' | 'none';
  /** Compute the confirmation over another key (a man in the middle). */
  lie: boolean;
  outcome: 'approved' | 'denied' | 'expired' | 'busy' | 'never';
  pendingPolls: number;
  completes: Record<string, unknown>[];
  reveals: { ok: boolean }[];
  polls: { time: number; ok: boolean }[];
  registered: RegisterBody | null;
  close(): Promise<void>;
}

function verifies(key: string, text: string, signature: string): boolean {
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  return verify(null, Buffer.from(text), pub, Buffer.from(signature, 'base64url'));
}

async function scriptedHub(): Promise<ScriptedHub> {
  const identity = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const publicKey = (identity.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const hub: ScriptedHub = {
    url: '',
    publicKey,
    fingerprint: hubKeyFingerprint(publicKey),
    noIdentity: false,
    signature: 'good',
    lie: false,
    outcome: 'approved',
    pendingPolls: 1,
    completes: [],
    reveals: [],
    polls: [],
    registered: null,
    close: () => Promise.resolve(),
  };
  let device: Record<string, string> = {};
  let busy = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const body = raw ? JSON.parse(raw) : {};
      const time = Number(req.headers['x-nova-device-time']);
      const sig = String(req.headers['x-nova-device-signature']);
      if (req.method === 'GET' && req.url === '/api/v1/hello') {
        return send(200, {
          name: 'nova-hub',
          hubFingerprint: hub.noIdentity ? null : hub.fingerprint,
          hubPublicKey: hub.noIdentity ? null : hub.publicKey,
        });
      }
      if (req.url === '/api/v1/devices/add/complete') {
        hub.completes.push(body);
        device = body;
        return send(202, {
          requestId: 'req-1',
          pairingId: PAIRING,
          expiresAt: '2099-01-01T00:00:00.000Z',
          hubNonce: HUB_NONCE,
          status: 'committed',
        });
      }
      if (req.url === '/api/v1/devices/add/reveal') {
        const ok =
          verifies(device.publicKey!, `nova-add-device-reveal-v1.req-1.${time}`, sig) &&
          addDeviceCommitment(device.publicKey!, body.nonce) === device.commitment;
        hub.reveals.push({ ok });
        if (!ok) return send(401, { error: { code: 'auth_missing', message: 'bad reveal' } });
        const key = hub.lie ? generateKeys().publicKey : device.publicKey!;
        const confirmation = addDeviceConfirmation({
          hubFingerprint: hub.noIdentity ? '' : hub.fingerprint,
          pairingId: PAIRING,
          publicKey: key,
          code: device.code!,
          deviceNonce: body.nonce,
          hubNonce: HUB_NONCE,
        });
        const statement = `nova-add-device-reveal-v1|req-1|${PAIRING}|${device.publicKey}|${confirmation}`;
        const signer = hub.signature === 'other' ? other.privateKey : identity.privateKey;
        const hubSignature =
          hub.noIdentity || hub.signature === 'none'
            ? null
            : sign(null, Buffer.from(statement), signer).toString('base64url');
        return send(200, { requestId: 'req-1', confirmation, status: 'pending', hubSignature });
      }
      if (req.url === '/api/v1/devices/add/status/req-1') {
        const ok = verifies(device.publicKey!, `nova-add-device-status-v1.req-1.${time}`, sig);
        hub.polls.push({ time, ok });
        if (!ok) return send(401, { error: { code: 'auth_missing', message: 'bad signature' } });
        if (hub.polls.length <= hub.pendingPolls || hub.outcome === 'never')
          return send(200, { status: 'pending' });
        if (hub.outcome === 'busy' && busy++ < 1)
          return send(429, { error: { code: 'rate_limited', message: 'slow down' } });
        if (hub.outcome === 'denied' || hub.outcome === 'expired')
          return send(200, { status: hub.outcome });
        return send(200, {
          status: 'approved',
          deviceId: 'dev-1',
          grant: { type: 'compute', enrollToken: 'nve_granted' },
        });
      }
      if (req.url === '/node/v1/register') {
        if (body.enrollToken !== 'nve_granted')
          return send(401, { error: { code: 'auth_missing', message: 'bad token' } });
        hub.registered = body;
        return send(201, {
          nodeId: 'dev-1',
          credential: 'nvn_cred',
          heartbeatIntervalMs: 10_000,
          protocolVersion: 1,
        });
      }
      return send(404, { error: { code: 'not_found', message: req.url } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hub.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return hub;
}

let dir: string;
let hub: ScriptedHub;
let backend: FakeBackend;
let clock: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-compute-join-'));
  hub = await scriptedHub();
  backend = await startFakeBackend({ models: ['llama3'] });
  clock = Date.parse('2026-10-17T10:00:00.000Z');
});

afterEach(async () => {
  await hub.close();
  await backend.close();
  rmSync(dir, { recursive: true, force: true });
});

function startJoin(extra: Partial<Parameters<typeof joinWithCode>[0]> = {}) {
  const shown: string[] = [];
  const p = joinWithCode({
    hubUrl: hub.url,
    code: 'abcd efgh',
    backendUrl: backend.url,
    backendKind: 'llamacpp',
    name: 'gpu-box',
    listen: '127.0.0.1:0',
    advertise: 'http://127.0.0.1:7420',
    dataDir: dir,
    onConfirmation: (c) => shown.push(c),
    pollIntervalMs: 1,
    // Each sleep moves the simulated clock by half a second.
    now: () => clock,
    sleep: () => {
      clock += 500;
      return Promise.resolve();
    },
    ...extra,
  });
  return { p, shown };
}

describe('the code and the proofs', () => {
  it('normalizes codes like the Hub', () => {
    expect(normalizeAddDeviceCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeAddDeviceCode('O1IL 0000')).toBe('01110000');
    expect(normalizeAddDeviceCode('ABCD-EFGU')).toBeNull();
  });

  it('computes the Hub fixed vectors and signs the reveal and status polls', () => {
    const publicKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    // Computed independently (Python hashlib).
    expect(addDeviceCommitment(publicKey, 'n'.repeat(43))).toBe(
      'oGgjvQosYMHcFu38ZkxXFuaQSn8Z9bQQeOn1AmdB6zo',
    );
    expect(
      addDeviceConfirmation({
        hubFingerprint: '',
        pairingId: PAIRING,
        publicKey,
        code: 'abcd-efgh',
        deviceNonce: 'n'.repeat(43),
        hubNonce: 'h'.repeat(43),
      }),
    ).toBe('914051');
    expect(formatConfirmation('914051')).toBe('914 051');
    const keys = generateKeys();
    expect(
      verifies(
        keys.publicKey,
        'nova-add-device-status-v1.r.42',
        signAddDeviceStatus(keys.privateKeyPem, 'r', 42),
      ),
    ).toBe(true);
    expect(
      verifies(
        keys.publicKey,
        'nova-add-device-reveal-v1.r.42',
        signAddDeviceReveal(keys.privateKeyPem, 'r', 42),
      ),
    ).toBe(true);
    expect(hubKeyFingerprint(keys.publicKey)).toBe(
      createHash('sha256').update(Buffer.from(keys.publicKey, 'base64url')).digest('base64url'),
    );
    expect(
      verifyHubReveal('short', 'x', {
        requestId: 'r',
        pairingId: 'p',
        publicKey: 'k',
        confirmation: '1',
      }),
    ).toBe(false);
  });
});

describe('joining with a code', () => {
  it('commits, reveals, checks the pinned Hub, waits for approval and registers', async () => {
    const { p, shown } = startJoin({ pairingId: PAIRING, pin: hub.fingerprint });
    const state = await p;
    const sent = hub.completes[0]!;
    expect(sent).toMatchObject({
      pairingId: PAIRING,
      code: 'ABCDEFGH',
      name: 'gpu-box',
      kind: 'compute',
    });
    // The commitment went with complete; the nonce only with the reveal.
    expect(sent.commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent).not.toHaveProperty('nonce');
    expect(hub.reveals).toEqual([{ ok: true }]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^\d{6}$/);
    // Every status poll is signed and carries a strictly newer time.
    expect(hub.polls.every((x) => x.ok)).toBe(true);
    const times = hub.polls.map((x) => x.time);
    expect(times).toEqual([...new Set(times)].sort((a, b) => a - b));
    expect(hub.registered?.publicKey).toBe(sent.publicKey);
    expect(state.enrollment).toMatchObject({ nodeId: 'dev-1', publicKey: sent.publicKey });
    expect(loadState(dir)?.enrollment?.nodeId).toBe('dev-1');
    await expect(startJoin().p).rejects.toThrow(/already enrolled/);
  });

  it('works without a pin and without a Hub identity', async () => {
    hub.noIdentity = true;
    await startJoin().p;
    expect(hub.registered).not.toBeNull();
  });

  it('retries a busy Hub, and stops on a denial or an expiry', async () => {
    hub.outcome = 'busy';
    await startJoin().p;
    expect(hub.registered).not.toBeNull();
    for (const outcome of ['denied', 'expired'] as const) {
      const d = mkdtempSync(join(tmpdir(), 'nova-compute-join-'));
      hub.outcome = outcome;
      hub.polls = [];
      await expect(startJoin({ dataDir: d }).p).rejects.toThrow(
        outcome === 'denied' ? /denied/ : /expired/,
      );
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('stops on a different confirmation, a wrong pin, a missing or bad Hub signature', async () => {
    hub.lie = true;
    await expect(startJoin().p).rejects.toThrow(/different confirmation/);
    hub.lie = false;
    const before = hub.completes.length;
    // The pin names a key that is not the Hub's: nothing is sent at all.
    await expect(startJoin({ pin: hubKeyFingerprint(generateKeys().publicKey) }).p).rejects.toThrow(
      /not your Hub/,
    );
    expect(hub.completes).toHaveLength(before);
    hub.signature = 'none';
    await expect(startJoin({ pin: hub.fingerprint }).p).rejects.toThrow(/not your Hub/);
    hub.signature = 'other';
    await expect(startJoin({ pin: hub.fingerprint }).p).rejects.toThrow(/not your Hub/);
    hub.noIdentity = true;
    await expect(startJoin({ pin: hub.fingerprint }).p).rejects.toThrow(/not your Hub/);
    await expect(startJoin({ code: 'nope' }).p).rejects.toThrow(/8 letters/);
    expect(hub.registered).toBeNull();
  });

  it('gives up when nobody approves in time', async () => {
    hub.outcome = 'never';
    await expect(startJoin({ timeoutMs: 5000 }).p).rejects.toThrow(/in time/);
  });

  it('says so when the backend does not answer', async () => {
    await expect(startJoin({ backendUrl: 'http://127.0.0.1:9' }).p).rejects.toThrow(
      /did not answer/,
    );
    expect(hub.completes).toEqual([]);
  });
});
