// Add Device in core (FR-132, FR-140; docs/22 §4, §9): the code format and its hash, the
// confirmation as a fixed vector (computed independently), TTL, single use, the attempt limit, the
// per-account start limit, signed status polls (wrong key, stale and replayed times), the grant
// handed out once, deny, expiry, revocation with blocked keys, the Relay seam, and that neither a
// code nor a grant reaches an event or audit row.
import { generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type AddDeviceKind } from '@nova/shared';
import { hashToken } from '@nova/security';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  addDeviceCommitment,
  addDeviceConfirmation,
  generateKeys,
  normalizeAddDeviceCode,
  signAddDeviceReveal,
  signAddDeviceStatus,
  verifyHubReveal,
} from '@nova/compute';
import {
  MemoryEventSink,
  PAIRING_CODE_ALPHABET,
  PairingService,
  SlidingWindowLimiter,
  displayPairingCode,
  enrollBindingOf,
  newPairingCode,
  normalizeConfirmation,
  normalizePairingCode,
  pairingCodeHash,
  pairingCommitment,
  pairingConfirmation,
  pairingConfirmationV2,
  pairingRevealMessage,
  pairingStatusMessage,
  hubRevealStatement,
  verifyPairingRevealSignature,
  verifyPairingStatusSignature,
  type AuditRecord,
  type PairingDecision,
  type PairingGrantContext,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';

let db: NovaDatabase;
let events: MemoryEventSink;
let audit: AuditRecord[];
let clock: { now: number };
let enabled: boolean;
let svc: PairingService;
let issued: PairingGrantContext[];

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  events = new MemoryEventSink();
  audit = [];
  clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  enabled = true;
  issued = [];
  svc = new PairingService({
    db,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    now: () => new Date(clock.now),
    settings: { enabled: () => Promise.resolve(enabled), sessionDays: () => Promise.resolve(7) },
    grants: {
      novad: (g) => (issued.push(g), Promise.resolve('nvd_granted-novad-token')),
      compute: (g) => (issued.push(g), Promise.resolve('nve_granted-compute-token')), // secret-scan: fake
    },
  });
});

afterEach(() => {
  svc.stopSweeper();
  db.close();
});

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}

function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: (publicKey.export({ format: 'jwk' }) as { x: string }).x, privateKey };
}

function signed(key: Key, requestId: string, time = Math.floor(clock.now / 1000)) {
  return {
    time: String(time),
    signature: sign(null, pairingStatusMessage(requestId, time), key.privateKey).toString(
      'base64url',
    ),
  };
}

async function rejects(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

const tick = (ms: number) => {
  clock.now += ms;
};

/** 32 random bytes, base64url: a device's secret nonce. */
function nonce(): string {
  return randomBytes(32).toString('base64url');
}

/** `complete` with a commitment to `n` (v2). */
function commit(s: PairingService, body: Record<string, unknown>, n = nonce()) {
  return s.complete({ ...body, commitment: pairingCommitment(String(body.publicKey), n) });
}

/** The signed headers of a reveal. */
function revealProof(key: Key, requestId: string, time = Math.floor(clock.now / 1000)) {
  return {
    time: String(time),
    signature: sign(null, pairingRevealMessage(requestId, time), key.privateKey).toString(
      'base64url',
    ),
  };
}

/** Commit and reveal (Add Device v2), as a device does. */
async function joinWith(
  s: PairingService,
  started: { pairingId: string; code: string },
  key: Key,
  kind: AddDeviceKind = 'browser',
) {
  const deviceNonce = nonce();
  const committed = await commit(
    s,
    {
      pairingId: started.pairingId,
      code: started.code,
      publicKey: key.publicKey,
      name: 'Phone',
      platform: 'ios',
      kind,
    },
    deviceNonce,
  );
  const revealed = await s.reveal(
    { requestId: committed.requestId, nonce: deviceNonce },
    revealProof(key, committed.requestId),
  );
  return { committed, deviceNonce, done: { ...revealed, pairingId: committed.pairingId } };
}

async function joined(
  opts: { role?: 'client' | 'compute' | 'wake-helper'; kind?: AddDeviceKind; key?: Key } = {},
) {
  const key = opts.key ?? newKey();
  const started = await svc.start(ACCOUNT, {
    role: opts.role ?? 'client',
    scopes: ['offline-replica'],
  });
  return { key, started, ...(await joinWith(svc, started, key, opts.kind ?? 'browser')) };
}

describe('codes and confirmations', () => {
  it('makes 8-character Crockford codes shown as ABCD-EFGH', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newPairingCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(200);
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(displayPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('normalizes what a person types, and refuses what is not a code', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ab cd ef gh ')).toBe('ABCDEFGH');
    // Crockford's look-alikes.
    expect(normalizePairingCode('O1IL-0000')).toBe('01110000');
    expect(normalizePairingCode('ABCD-EFGU')).toBeNull();
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFGHJ')).toBeNull();
    expect(normalizeConfirmation('123 456')).toBe('123456');
    expect(normalizeConfirmation('12345')).toBeNull();
  });

  it('computes the confirmation and the code hash as fixed vectors', () => {
    const base = {
      pairingId: '01920000-0000-7000-8000-00000000aaaa',
      publicKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      code: 'abcd-efgh',
    };
    // Computed independently (Python hashlib): SHA-256 of the joined fields, mod 10^6.
    expect(pairingConfirmation({ ...base, hubFingerprint: '' })).toBe('894633');
    expect(
      pairingConfirmation({
        ...base,
        hubFingerprint: 'yAs9pQmQ0Kq6tU1t7mNfLwVd9a4m8Wq3b5r2s1x0z7c',
      }),
    ).toBe('159184');
    expect(pairingCodeHash(base.pairingId, 'ABCD-EFGH')).toBe(
      'b9cf464b464cbc25c935ca9b478d4bec7f57d005fc5bf346139c494f0eb1b229',
    );
    expect(pairingCodeHash(base.pairingId, base.code)).toBe(
      pairingCodeHash(base.pairingId, 'ABCDEFGH'),
    );
    // v2 (computed independently too): the commitment and the confirmation over both nonces.
    expect(pairingCommitment(base.publicKey, 'n'.repeat(43))).toBe(
      'oGgjvQosYMHcFu38ZkxXFuaQSn8Z9bQQeOn1AmdB6zo',
    );
    const v2 = { ...base, deviceNonce: 'n'.repeat(43), hubNonce: 'h'.repeat(43) };
    expect(pairingConfirmationV2({ ...v2, hubFingerprint: '' })).toBe('914051');
    expect(
      pairingConfirmationV2({
        ...v2,
        hubFingerprint: 'yAs9pQmQ0Kq6tU1t7mNfLwVd9a4m8Wq3b5r2s1x0z7c',
      }),
    ).toBe('721154');
    expect(
      hubRevealStatement({
        requestId: 'r',
        pairingId: 'p',
        publicKey: 'k',
        confirmation: '123456',
      }).toString('utf8'),
    ).toBe('nova-add-device-reveal-v1|r|p|k|123456');
  });

  it('agrees with the compute node on codes, commitments, confirmations and signatures', () => {
    const hub = newKey();
    for (let i = 0; i < 20; i++) {
      const code = newPairingCode();
      const keys = generateKeys();
      const input = {
        hubFingerprint: i % 2 ? '' : `fp${i}`,
        pairingId: `p-${i}`,
        publicKey: keys.publicKey,
        code: code.toLowerCase(),
        deviceNonce: nonce(),
        hubNonce: nonce(),
      };
      expect(addDeviceConfirmation(input)).toBe(pairingConfirmationV2(input));
      expect(addDeviceCommitment(keys.publicKey, input.deviceNonce)).toBe(
        pairingCommitment(keys.publicKey, input.deviceNonce),
      );
      expect(normalizeAddDeviceCode(code)).toBe(normalizePairingCode(code));
      const sig = signAddDeviceStatus(keys.privateKeyPem, `r${i}`, 1000 + i);
      expect(verifyPairingStatusSignature(keys.publicKey, `r${i}`, 1000 + i, sig)).toBe(true);
      const rev = signAddDeviceReveal(keys.privateKeyPem, `r${i}`, 1000 + i);
      expect(verifyPairingRevealSignature(keys.publicKey, `r${i}`, 1000 + i, rev)).toBe(true);
      expect(verifyPairingStatusSignature(keys.publicKey, `r${i}`, 1000 + i, rev)).toBe(false);
      const statement = {
        requestId: `r${i}`,
        pairingId: input.pairingId,
        publicKey: keys.publicKey,
        confirmation: '123456',
      };
      const hubSig = sign(null, hubRevealStatement(statement), hub.privateKey).toString(
        'base64url',
      );
      expect(verifyHubReveal(hub.publicKey, hubSig, statement)).toBe(true);
      expect(verifyHubReveal(keys.publicKey, hubSig, statement)).toBe(false);
    }
  });

  it('verifies status signatures by the device key only', () => {
    const key = newKey();
    const other = newKey();
    const s = sign(null, pairingStatusMessage('r1', 100), key.privateKey).toString('base64url');
    expect(verifyPairingStatusSignature(key.publicKey, 'r1', 100, s)).toBe(true);
    expect(verifyPairingStatusSignature(other.publicKey, 'r1', 100, s)).toBe(false);
    expect(verifyPairingStatusSignature(key.publicKey, 'r1', 101, s)).toBe(false);
    expect(verifyPairingStatusSignature(key.publicKey, 'r2', 100, s)).toBe(false);
    expect(verifyPairingStatusSignature('short', 'r1', 100, s)).toBe(false);
    expect(verifyPairingStatusSignature(key.publicKey, 'r1', 100, 'nope')).toBe(false);
  });

  it('reads an enrollment binding from token scopes', () => {
    expect(enrollBindingOf(JSON.stringify({ bind: { publicKey: 'k', deviceId: 'd' } }))).toEqual({
      publicKey: 'k',
      deviceId: 'd',
    });
    expect(enrollBindingOf(JSON.stringify({ novad: true, roles: ['client'] }))).toBeNull();
    expect(enrollBindingOf('not json')).toBeNull();
    expect(enrollBindingOf(null)).toBeNull();
  });
});

describe('start and complete', () => {
  it('stores only the code hash and audits the start without the code', async () => {
    const started = await svc.start(ACCOUNT, { role: 'client', scopes: ['a', 'a'], name: 'Pad' });
    expect(started.expiresAt).toBe(new Date(clock.now + 5 * 60_000).toISOString());
    expect(started.scopes).toEqual(['a']);
    expect(started.transport).toBe('direct');
    const row = db.raw.prepare('SELECT * FROM device_pairing').get() as Record<string, unknown>;
    expect(row.code_hash).toBe(pairingCodeHash(started.pairingId, started.code));
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM device_pairing').all());
    expect(dump).not.toContain(started.code);
    expect(dump).not.toContain(started.code.replace('-', ''));
    expect(audit.map((a) => a.action)).toEqual(['device.add.start']);
    expect(JSON.stringify(audit)).not.toContain(started.code.replace('-', ''));
  });

  it('commits, then reveals: only then the owner sees the request and its confirmation', async () => {
    const key = newKey();
    const started = await svc.start(ACCOUNT, { role: 'client', scopes: ['offline-replica'] });
    const deviceNonce = nonce();
    const committed = await commit(
      svc,
      {
        pairingId: started.pairingId,
        code: started.code,
        publicKey: key.publicKey,
        name: 'Phone',
        platform: 'ios',
        kind: 'browser',
      },
      deviceNonce,
    );
    expect(committed).toMatchObject({ pairingId: started.pairingId, status: 'committed' });
    expect(committed.hubNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(committed.expiresAt).toBe(new Date(clock.now + 2 * 60_000).toISOString());
    expect(committed).not.toHaveProperty('confirmation');
    // Nothing for the owner yet, and the device's poll says pending.
    expect(events.names()).toEqual([]);
    expect(await svc.requests(ACCOUNT, 'all')).toEqual([]);
    expect(
      (await svc.status(committed.requestId, signed(key, committed.requestId), { hubUrl: 'h' }))
        .view,
    ).toEqual({ status: 'pending' });
    expect((await rejects(svc.approve(ACCOUNT, committed.requestId, '123456'))).code).toBe(
      'not_found',
    );
    expect(audit.at(-1)).toMatchObject({ action: 'device.add.complete', result: 'committed' });

    tick(1000);
    const revealed = await svc.reveal(
      { requestId: committed.requestId, nonce: deviceNonce },
      revealProof(key, committed.requestId),
    );
    expect(revealed).toMatchObject({ requestId: committed.requestId, status: 'pending' });
    // No Hub identity yet: no signature, and '' stands for the fingerprint.
    expect(revealed.hubSignature).toBeNull();
    expect(revealed.confirmation).toBe(
      pairingConfirmationV2({
        hubFingerprint: '',
        pairingId: started.pairingId,
        publicKey: key.publicKey,
        code: started.code,
        deviceNonce,
        hubNonce: committed.hubNonce,
      }),
    );
    expect(events.names()).toEqual(['device.add.requested']);
    expect(events.events[0]!.payload).toEqual({
      requestId: committed.requestId,
      role: 'client',
      kind: 'browser',
      platform: 'ios',
      name: 'Phone',
    });
    const [req] = await svc.requests(ACCOUNT);
    expect(req).toMatchObject({
      id: committed.requestId,
      status: 'pending',
      confirmation: revealed.confirmation,
      scopes: ['offline-replica'],
      expiresAt: new Date(clock.now + 10 * 60_000).toISOString(),
    });
    // One reveal per request.
    const again = await rejects(
      svc.reveal(
        { requestId: committed.requestId, nonce: deviceNonce },
        revealProof(key, committed.requestId),
      ),
    );
    expect(again.code).toBe('conflict');
    expect(again.details).toEqual({ reason: 'already_revealed' });
    expect(audit.map((a) => a.action)).toEqual([
      'device.add.start',
      'device.add.complete',
      'device.add.reveal',
    ]);
  });

  it('burns the request on a wrong nonce or signature, counting against its pairing', async () => {
    const reveal = async (bad: 'nonce' | 'signature') => {
      const key = newKey();
      const started = await svc.start(ACCOUNT, { role: 'client' });
      const deviceNonce = nonce();
      const c = await commit(
        svc,
        {
          pairingId: started.pairingId,
          code: started.code,
          publicKey: key.publicKey,
          name: 'x',
          platform: 'x',
          kind: 'browser',
        },
        deviceNonce,
      );
      const proof =
        bad === 'signature' ? revealProof(newKey(), c.requestId) : revealProof(key, c.requestId);
      const e = await rejects(
        svc.reveal(
          { requestId: c.requestId, nonce: bad === 'nonce' ? nonce() : deviceNonce },
          proof,
        ),
      );
      expect(e.code).toBe('auth_missing');
      expect(e.details).toEqual({ reason: 'bad_reveal' });
      // Burned: the right reveal no longer works and the device's poll says denied.
      const late = await rejects(
        svc.reveal({ requestId: c.requestId, nonce: deviceNonce }, revealProof(key, c.requestId)),
      );
      expect(late.code).toBe('request_expired');
      expect(
        (await svc.status(c.requestId, signed(key, c.requestId), { hubUrl: 'h' })).view.status,
      ).toBe('denied');
      const pairing = db.raw
        .prepare('SELECT attempts FROM device_pairing WHERE id = ?')
        .get(started.pairingId) as { attempts: number };
      expect(pairing.attempts).toBe(1);
    };
    await reveal('nonce');
    await reveal('signature');
    expect(
      audit
        .filter((a) => a.action === 'device.add.reveal')
        .map((a) => [a.result, a.detail?.reason]),
    ).toEqual([
      ['denied', 'bad_reveal'],
      ['denied', 'bad_reveal'],
    ]);
    expect(events.names()).toEqual([]);
    expect(await svc.requests(ACCOUNT, 'all')).toEqual([]);
  });

  it('refuses a reveal that is late, stale, unsigned, unknown or after a restart', async () => {
    const key = newKey();
    const started = await svc.start(ACCOUNT, { role: 'client' });
    const deviceNonce = nonce();
    const body = {
      pairingId: started.pairingId,
      code: started.code,
      publicKey: key.publicKey,
      name: 'x',
      platform: 'x',
      kind: 'browser',
    };
    const c = await commit(svc, body, deviceNonce);
    const reason = async (p: Promise<unknown>) => (await rejects(p)).details?.reason;
    const nowS = Math.floor(clock.now / 1000);
    expect(
      await reason(
        svc.reveal(
          { requestId: c.requestId, nonce: deviceNonce },
          { time: undefined, signature: 'x' },
        ),
      ),
    ).toBe('missing_proof');
    // A good signature over a stale time is refused without burning the request.
    expect(
      await reason(
        svc.reveal(
          { requestId: c.requestId, nonce: deviceNonce },
          revealProof(key, c.requestId, nowS - 61),
        ),
      ),
    ).toBe('stale_time');
    expect(
      await reason(
        svc.reveal(
          { requestId: '01920000-0000-7000-8000-00000000ffff', nonce: deviceNonce },
          revealProof(key, '01920000-0000-7000-8000-00000000ffff'),
        ),
      ),
    ).toBe('bad_signature');
    // A restarted Hub has lost the code kept for the reveal: the request expires.
    const restarted = new PairingService({ db, events, now: () => new Date(clock.now) });
    const gone = await rejects(
      restarted.reveal(
        { requestId: c.requestId, nonce: deviceNonce },
        revealProof(key, c.requestId),
      ),
    );
    expect(gone.code).toBe('request_expired');

    // Two minutes without a reveal: expired, never shown to the owner.
    const s2 = await svc.start(ACCOUNT, { role: 'client' });
    const k2 = newKey();
    const n2 = nonce();
    const c2 = await commit(
      svc,
      { ...body, pairingId: s2.pairingId, code: s2.code, publicKey: k2.publicKey },
      n2,
    );
    tick(2 * 60_000);
    const late = await rejects(
      svc.reveal({ requestId: c2.requestId, nonce: n2 }, revealProof(k2, c2.requestId)),
    );
    expect(late.code).toBe('request_expired');
    const s3 = await svc.start(ACCOUNT, { role: 'client' });
    const k3 = newKey();
    const c3 = await commit(svc, {
      ...body,
      pairingId: s3.pairingId,
      code: s3.code,
      publicKey: k3.publicKey,
    });
    tick(2 * 60_000);
    expect((await svc.sweep()).requests).toBe(1);
    expect(
      (await svc.status(c3.requestId, signed(k3, c3.requestId), { hubUrl: 'h' })).view.status,
    ).toBe('expired');
    // (The restarted instance has no audit sink; this one recorded its two.)
    expect(
      audit.filter((a) => a.action === 'device.add.expire').map((a) => a.detail?.what),
    ).toEqual(['commit', 'commit']);
    expect(await svc.requests(ACCOUNT, 'all')).toEqual([]);
    expect(events.names()).toEqual([]);
  });

  it('stops an on-path attacker from matching the device confirmation (review finding 1)', async () => {
    // The attacker sees the code, the pairing id and the victim key in transit (as in v1) and
    // relays everything. It must commit to its own key and nonce before it learns the Hub nonce,
    // so it can no longer grind a key whose digits match the victim's.
    const body = (started: { pairingId: string; code: string }, key: Key) => ({
      pairingId: started.pairingId,
      code: started.code,
      publicKey: key.publicKey,
      name: 'Phone',
      platform: 'ios',
      kind: 'browser',
    });
    const attacker = newKey();
    const victim = newKey();
    const victimNonce = nonce();
    // Revealing anything but the committed nonce (say, after learning the victim's) burns it.
    const s1 = await svc.start(ACCOUNT, { role: 'client' });
    const c1 = await commit(svc, body(s1, attacker), nonce());
    const swapped = await rejects(
      svc.reveal(
        { requestId: c1.requestId, nonce: victimNonce },
        revealProof(attacker, c1.requestId),
      ),
    );
    expect(swapped.details).toEqual({ reason: 'bad_reveal' });
    // With the committed nonce, the Hub's digits match the victim's only by a 1-in-10^6 chance.
    let matched = 0;
    for (let i = 0; i < 5; i++) {
      const started = await svc.start(ACCOUNT, { role: 'client' });
      const attackerNonce = nonce();
      const c = await commit(svc, body(started, attacker), attackerNonce);
      const hubShows = await svc.reveal(
        { requestId: c.requestId, nonce: attackerNonce },
        revealProof(attacker, c.requestId),
      );
      const victimShows = pairingConfirmationV2({
        hubFingerprint: '',
        pairingId: started.pairingId,
        publicKey: victim.publicKey,
        code: started.code,
        deviceNonce: victimNonce,
        hubNonce: c.hubNonce,
      });
      if (hubShows.confirmation === victimShows) matched++;
    }
    expect(matched).toBe(0);
  });

  it('finds the pairing from the code alone, with its own guess budget (review finding 4)', async () => {
    const a = await svc.start(ACCOUNT, { role: 'compute' });
    const b = await svc.start(ACCOUNT, { role: 'client' });
    const key = newKey();
    const body = (code: string, pairingId?: string) => ({
      ...(pairingId ? { pairingId } : {}),
      code,
      publicKey: key.publicKey,
      name: 'gpu-box',
      platform: 'linux',
      kind: 'compute',
    });
    const wrong = [a.code, b.code].includes('ZZZZ-ZZZZ') ? 'YYYY-YYYY' : 'ZZZZ-ZZZZ';
    // The reviewer's probe: five unauthenticated code-only guesses used to burn every pairing.
    const left: unknown[] = [];
    for (let i = 0; i < 9; i++) {
      const e = await rejects(commit(svc, body(wrong)));
      expect(e.code).toBe('auth_missing');
      left.push(e.details?.attemptsLeft);
    }
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // The pairings are untouched.
    expect(db.raw.prepare('SELECT attempts, status FROM device_pairing').all()).toEqual([
      { attempts: 0, status: 'open' },
      { attempts: 0, status: 'open' },
    ]);
    // The tenth spends the budget: code-only completes are refused for 5 minutes, even right ones.
    expect((await rejects(commit(svc, body(wrong)))).details).toEqual({
      reason: 'wrong_code',
      attemptsLeft: 0,
    });
    const locked = await rejects(commit(svc, body(a.code)));
    expect(locked.code).toBe('rate_limited');
    expect(locked.details).toEqual({ reason: 'code_only_locked' });
    // The QR and the install command carry the pairing id: they still work.
    const viaQr = await commit(svc, { ...body(b.code, b.pairingId), kind: 'novad' });
    expect(viaQr.status).toBe('committed');
    // Five minutes later code-only completes work again (on a new pairing: the old ones expired).
    tick(5 * 60_000 + 1);
    const c = await svc.start(ACCOUNT, { role: 'compute' });
    const done = await commit(svc, body(c.code.toLowerCase()));
    expect(done.pairingId).toBe(c.pairingId);
    expect(
      audit.filter((x) => x.action === 'device.add.complete' && x.result === 'denied'),
    ).toHaveLength(11);
    // No open pairing left: the answer is the expired one.
    expect((await rejects(commit(svc, body(a.code)))).code).toBe('request_expired');
  });

  it('allows 20 starts an hour per account', async () => {
    for (let i = 0; i < 20; i++) await svc.start(ACCOUNT, { role: 'client' });
    const e = await rejects(svc.start(ACCOUNT, { role: 'client' }));
    expect(e.code).toBe('rate_limited');
    expect(e.details).toMatchObject({ reason: 'start_rate_limited', limit: 20 });
    // Another account is not affected; an hour later this one can start again.
    await svc.start(OTHER, { role: 'client' });
    tick(60 * 60_000 + 1);
    await svc.start(ACCOUNT, { role: 'client' });
  });

  it('refuses kinds the role does not take, and keys already registered', async () => {
    const started = await svc.start(ACCOUNT, { role: 'wake-helper' });
    const body = {
      pairingId: started.pairingId,
      code: started.code,
      publicKey: newKey().publicKey,
      name: 'Helper',
      platform: 'linux',
      kind: 'browser',
    };
    const e = await rejects(commit(svc, body));
    expect(e.code).toBe('validation');
    expect(e.details).toMatchObject({ reason: 'kind_not_allowed' });
    // The right kind still works with the same code (a refused kind does not burn it).
    const ok = await commit(svc, { ...body, kind: 'novad' });
    expect(ok.status).toBe('committed');

    const taken = newKey();
    const { done } = await joined({ key: taken });
    await svc.approve(ACCOUNT, done.requestId, done.confirmation);
    const s2 = await svc.start(ACCOUNT, { role: 'client' });
    const conflict = await rejects(
      commit(svc, {
        pairingId: s2.pairingId,
        code: s2.code,
        publicKey: taken.publicKey,
        name: 'Again',
        platform: 'ios',
        kind: 'browser',
      }),
    );
    expect(conflict.code).toBe('conflict');
    expect(conflict.details).toEqual({ reason: 'key_in_use' });
  });

  it('is refused while Add Device is turned off', async () => {
    enabled = false;
    const e = await rejects(svc.start(ACCOUNT, { role: 'client' }));
    expect(e.code).toBe('policy_denied');
    expect(e.details).toEqual({ reason: 'add_device_disabled' });
    enabled = true;
    const started = await svc.start(ACCOUNT, { role: 'client' });
    enabled = false;
    const c = await rejects(
      commit(svc, {
        pairingId: started.pairingId,
        code: started.code,
        publicKey: newKey().publicKey,
        name: 'X',
        platform: 'linux',
        kind: 'browser',
      }),
    );
    expect(c.code).toBe('policy_denied');
  });

  it('binds the Hub identity into the confirmation and signs the reveal with it', async () => {
    expect(svc.hubFingerprint()).toBeNull();
    const hub = newKey();
    svc.useHubIdentity(() => ({
      fingerprint: 'hub-fp',
      sign: (bytes) => sign(null, Buffer.from(bytes), hub.privateKey),
    }));
    expect(svc.hubFingerprint()).toBe('hub-fp');
    const { key, started, committed, deviceNonce, done } = await joined();
    expect(done.confirmation).toBe(
      pairingConfirmationV2({
        hubFingerprint: 'hub-fp',
        pairingId: started.pairingId,
        publicKey: key.publicKey,
        code: started.code,
        deviceNonce,
        hubNonce: committed.hubNonce,
      }),
    );
    const statement = hubRevealStatement({
      requestId: done.requestId,
      pairingId: started.pairingId,
      publicKey: key.publicKey,
      confirmation: done.confirmation,
    });
    const hubKey = generateKeyPairSync('ed25519');
    expect(
      verify(
        null,
        statement,
        { key: { kty: 'OKP', crv: 'Ed25519', x: hub.publicKey }, format: 'jwk' },
        Buffer.from(done.hubSignature!, 'base64url'),
      ),
    ).toBe(true);
    // Not another key's signature.
    expect(
      verify(null, statement, hubKey.publicKey, Buffer.from(done.hubSignature!, 'base64url')),
    ).toBe(false);
    // An identity that cannot sign leaves the signature null; one that throws counts as none.
    svc.useHubIdentity(() => ({
      fingerprint: 'hub-fp',
      sign: () => {
        throw new Error('key not loaded');
      },
    }));
    expect((await joined()).done.hubSignature).toBeNull();
    svc.useHubIdentity(() => {
      throw new Error('vault locked');
    });
    expect(svc.hubFingerprint()).toBeNull();
  });
});

describe('approval and the status poll', () => {
  it('hands a browser its session exactly once, tied to the device', async () => {
    const { key, done } = await joined();
    const pending = await svc.status(done.requestId, signed(key, done.requestId), {
      hubUrl: 'http://hub',
    });
    expect(pending.view).toEqual({ status: 'pending' });

    const wrong = await rejects(svc.approve(ACCOUNT, done.requestId, '000000'));
    if (done.confirmation === '000000') throw new Error('unlucky confirmation');
    expect(wrong.code).toBe('validation');
    expect(wrong.details).toMatchObject({ reason: 'confirmation_mismatch' });
    expect((await rejects(svc.approve(OTHER, done.requestId, done.confirmation))).code).toBe(
      'not_found',
    );
    const approved = await svc.approve(
      ACCOUNT,
      done.requestId,
      `${done.confirmation.slice(0, 3)} ${done.confirmation.slice(3)}`,
    );
    expect(approved.status).toBe('approved');
    const deviceId = approved.deviceId!;
    const dev = db.raw.prepare('SELECT * FROM device WHERE id = ?').get(deviceId) as Record<
      string,
      unknown
    >;
    expect(dev).toMatchObject({
      kind: 'client',
      status: 'active',
      public_key: key.publicKey,
      roles: '["client"]',
      scopes: '["offline-replica"]',
      offline_replica: 1,
    });
    expect((await rejects(svc.approve(ACCOUNT, done.requestId, done.confirmation))).code).toBe(
      'conflict',
    );

    tick(2000);
    const first = await svc.status(done.requestId, signed(key, done.requestId), {
      hubUrl: 'http://hub',
    });
    expect(first.view.status).toBe('approved');
    expect(first.view.deviceId).toBe(deviceId);
    expect(first.kind).toBe('browser');
    expect(first.sessionMaxAgeS).toBe(7 * 24 * 60 * 60);
    const grant = first.view.grant;
    if (grant?.type !== 'session') throw new Error('expected a session grant');
    expect(grant.token).toMatch(/^nvx_/);
    const token = db.raw
      .prepare('SELECT * FROM auth_token WHERE token_hash = ?')
      .get(hashToken(grant.token)) as Record<string, unknown>;
    expect(token).toMatchObject({ kind: 'session', account_id: ACCOUNT });
    expect(token.expires_at).toBe(new Date(clock.now + 7 * 24 * 60 * 60_000).toISOString());
    expect(db.raw.prepare('SELECT device_id FROM device_session').all()).toEqual([
      { device_id: deviceId },
    ]);

    tick(2000);
    const second = await svc.status(done.requestId, signed(key, done.requestId), {
      hubUrl: 'http://hub',
    });
    expect(second.view).toEqual({ status: 'approved', deviceId });

    // Neither the grant nor the code reached an event or the audit log.
    const trail = JSON.stringify([events.events, audit]);
    expect(trail).not.toContain(grant.token);
    expect(events.names()).toEqual(['device.add.requested', 'device.add.decided']);
    expect(events.events[1]!.payload).toEqual({ requestId: done.requestId, decision: 'approved' });
    expect(audit.map((a) => a.action)).toEqual([
      'device.add.start',
      'device.add.complete',
      'device.add.reveal',
      'device.add.approve',
    ]);
    const summary = await svc.summary(ACCOUNT, deviceId);
    expect(summary).toMatchObject({ addedAs: 'browser', sessions: 1, status: 'active' });
  });

  it('refuses a wrong key, a stale or future time, and a replayed poll', async () => {
    const { key, done } = await joined();
    const other = newKey();
    const ctx = { hubUrl: 'http://hub' };
    const reason = async (p: Promise<unknown>) => (await rejects(p)).details?.reason;
    expect(await reason(svc.status(done.requestId, signed(other, done.requestId), ctx))).toBe(
      'bad_signature',
    );
    const nowS = Math.floor(clock.now / 1000);
    expect(
      await reason(svc.status(done.requestId, signed(key, done.requestId, nowS - 61), ctx)),
    ).toBe('stale_time');
    expect(
      await reason(svc.status(done.requestId, signed(key, done.requestId, nowS + 61), ctx)),
    ).toBe('stale_time');
    expect(await reason(svc.status(done.requestId, { time: undefined, signature: 'x' }, ctx))).toBe(
      'missing_proof',
    );
    expect(await reason(svc.status(done.requestId, { time: '12a', signature: 'x' }, ctx))).toBe(
      'missing_proof',
    );
    // An unknown request answers like a bad signature.
    expect(
      await reason(svc.status('01920000-0000-7000-8000-00000000ffff', signed(key, 'x'), ctx)),
    ).toBe('bad_signature');
    const poll = signed(key, done.requestId, nowS - 30);
    await svc.status(done.requestId, poll, ctx);
    expect(await reason(svc.status(done.requestId, poll, ctx))).toBe('replayed');
    // An older time than the last accepted one is a replay too; a newer one works.
    expect(
      await reason(svc.status(done.requestId, signed(key, done.requestId, nowS - 40), ctx)),
    ).toBe('replayed');
    expect(
      (await svc.status(done.requestId, signed(key, done.requestId, nowS), ctx)).view.status,
    ).toBe('pending');
  });

  it('hands novad and compute nodes a bound enrollment token, and retries a failed grant', async () => {
    const novad = await joined({ kind: 'novad' });
    await svc.approve(ACCOUNT, novad.done.requestId, novad.done.confirmation);
    const dev = db.raw
      .prepare(
        'SELECT d.kind, d.status FROM device d JOIN device_pairing_request r ON r.device_id = d.id WHERE r.id = ?',
      )
      .get(novad.done.requestId);
    expect(dev).toEqual({ kind: 'client', status: 'pending' });
    const n = await svc.status(novad.done.requestId, signed(novad.key, novad.done.requestId), {
      hubUrl: 'http://hub:7419',
    });
    expect(n.view.grant).toEqual({ type: 'novad', enrollToken: 'nvd_granted-novad-token' });
    expect(issued[0]).toMatchObject({
      accountId: ACCOUNT,
      kind: 'novad',
      role: 'client',
      publicKey: novad.key.publicKey,
      hubUrl: 'http://hub:7419',
      deviceId: n.view.deviceId,
    });

    // A grant that fails is not lost: the next poll gets it.
    let fail = true;
    svc.useGrants({
      compute: (g) => {
        if (fail) return Promise.reject(new Error('disk full'));
        issued.push(g);
        return Promise.resolve('nve_second-try');
      },
    });
    const node = await joined({ role: 'compute', kind: 'compute' });
    const approved = await svc.approve(ACCOUNT, node.done.requestId, node.done.confirmation);
    const row = db.raw
      .prepare('SELECT kind, status FROM device WHERE id = ?')
      .get(approved.deviceId);
    expect(row).toEqual({ kind: 'compute', status: 'pending' });
    const failed = await rejects(
      svc.status(node.done.requestId, signed(node.key, node.done.requestId), { hubUrl: 'h' }),
    );
    expect(failed.code).toBe('server_error');
    fail = false;
    tick(1000);
    const retry = await svc.status(node.done.requestId, signed(node.key, node.done.requestId), {
      hubUrl: 'h',
    });
    expect(retry.view.grant).toEqual({ type: 'compute', enrollToken: 'nve_second-try' });
  });

  it('says why a grant is missing when no issuer is wired', async () => {
    const bare = new PairingService({ db, events, now: () => new Date(clock.now) });
    const key = newKey();
    const started = await bare.start(ACCOUNT, { role: 'wake-helper' });
    const { done } = await joinWith(bare, started, key, 'novad');
    await bare.approve(ACCOUNT, done.requestId, done.confirmation);
    const e = await rejects(
      bare.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' }),
    );
    expect(e.code).toBe('capability_missing');
    expect(e.details).toEqual({ reason: 'grant_unavailable' });
    const dev = db.raw
      .prepare('SELECT kind FROM device WHERE public_key = ?')
      .get(key.publicKey) as { kind: string };
    expect(dev.kind).toBe('wake-helper');
  });

  it('adds a device certificate when the trust area can issue one', async () => {
    svc.useCertIssuer({
      issueDeviceCertificate: (input) =>
        Promise.resolve({ certificatePem: `PEM for ${input.role}`, expiresAt: 'later' }),
    });
    const a = await joined();
    await svc.approve(ACCOUNT, a.done.requestId, a.done.confirmation);
    const got = await svc.status(a.done.requestId, signed(a.key, a.done.requestId), {
      hubUrl: 'h',
    });
    expect(got.view.grant?.certificatePem).toBe('PEM for client');

    svc.useCertIssuer({ issueDeviceCertificate: () => Promise.reject(new Error('no CA')) });
    const b = await joined();
    await svc.approve(ACCOUNT, b.done.requestId, b.done.confirmation);
    const without = await svc.status(b.done.requestId, signed(b.key, b.done.requestId), {
      hubUrl: 'h',
    });
    expect(without.view.grant?.type).toBe('session');
    expect(without.view.grant?.certificatePem).toBeUndefined();

    // A trust mode without device certificates answers null: the grant stands without one.
    svc.useCertIssuer({ issueDeviceCertificate: () => Promise.resolve(null) });
    const c = await joined();
    await svc.approve(ACCOUNT, c.done.requestId, c.done.confirmation);
    const none = await svc.status(c.done.requestId, signed(c.key, c.done.requestId), {
      hubUrl: 'h',
    });
    expect(none.view.grant?.type).toBe('session');
    expect(none.view.grant?.certificatePem).toBeUndefined();
  });

  it("revokes the device's certificates with the device, and survives a failing issuer", async () => {
    const revoked: string[] = [];
    svc.useCertIssuer({
      issueDeviceCertificate: () => Promise.resolve(null),
      revokeDeviceCertificates: (id) => {
        revoked.push(id);
        return Promise.resolve(1);
      },
    });
    const a = await joined();
    const approvedA = await svc.approve(ACCOUNT, a.done.requestId, a.done.confirmation);
    await svc.revokeDevice(ACCOUNT, approvedA.deviceId!);
    expect(revoked).toEqual([approvedA.deviceId]);

    svc.useCertIssuer({
      issueDeviceCertificate: () => Promise.resolve(null),
      revokeDeviceCertificates: () => Promise.reject(new Error('CA unavailable')),
    });
    const b = await joined();
    const approvedB = await svc.approve(ACCOUNT, b.done.requestId, b.done.confirmation);
    await svc.revokeDevice(ACCOUNT, approvedB.deviceId!);
    expect(await svc.isKeyRevoked(b.key.publicKey)).toBe(true);
  });

  it('does not deny, audit or announce when a concurrent approval won', async () => {
    const decided: PairingDecision[] = [];
    svc.onDecided((d) => {
      decided.push(d);
    });
    const { done } = await joined();
    // The approval commits between deny's read and its write: the write must find nothing to deny.
    const prepare = db.raw.prepare.bind(db.raw);
    let raced = false;
    db.raw.prepare = (sql: string) => {
      if (!raced && /update\s+"?device_pairing_request"?\s+set\s+"?status"?\s*=/i.test(sql)) {
        raced = true;
        prepare("UPDATE device_pairing_request SET status = 'approved' WHERE id = ?").run(
          done.requestId,
        );
      }
      return prepare(sql);
    };
    try {
      const e = await rejects(svc.deny(ACCOUNT, done.requestId));
      expect(e.code).toBe('conflict');
      expect(e.details).toEqual({ reason: 'decided', status: 'approved' });
    } finally {
      db.raw.prepare = prepare;
    }
    expect(raced).toBe(true);
    expect(audit.some((a) => a.action === 'device.add.deny')).toBe(false);
    expect(decided).toEqual([]);
    expect(events.names()).not.toContain('device.add.decided');
  });

  it('denies, and tells the listeners', async () => {
    const decided: PairingDecision[] = [];
    const off = svc.onDecided((d) => {
      decided.push(d);
    });
    svc.onDecided(() => {
      throw new Error('a broken listener does not stop the others');
    });
    const { key, done } = await joined();
    const denied = await svc.deny(ACCOUNT, done.requestId);
    expect(denied.status).toBe('denied');
    expect(decided).toEqual([
      expect.objectContaining({ requestId: done.requestId, decision: 'denied', deviceId: null }),
    ]);
    const s = await svc.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' });
    expect(s.view).toEqual({ status: 'denied' });
    expect((await rejects(svc.deny(ACCOUNT, done.requestId))).code).toBe('conflict');
    expect(audit.at(-1)).toMatchObject({ action: 'device.add.deny', decision: 'denied' });
    off();
  });
});

describe('expiry', () => {
  it('expires open pairings, waiting requests and uncollected grants', async () => {
    const decided: PairingDecision[] = [];
    svc.onDecided((d) => {
      decided.push(d);
    });
    await svc.start(ACCOUNT, { role: 'client' });
    const waiting = await joined();
    const uncollected = await joined();
    await svc.approve(ACCOUNT, uncollected.done.requestId, uncollected.done.confirmation);
    tick(5 * 60_000);
    expect(await svc.sweep()).toEqual({ pairings: 1, requests: 0 });
    tick(5 * 60_000);
    expect(await svc.sweep()).toEqual({ pairings: 0, requests: 2 });
    expect(decided.map((d) => [d.requestId, d.decision])).toEqual([
      [uncollected.done.requestId, 'approved'],
      [waiting.done.requestId, 'expired'],
    ]);
    const all = await svc.requests(ACCOUNT, 'all');
    expect(all.map((r) => r.status).sort()).toEqual(['expired', 'expired']);
    expect(
      audit.filter((a) => a.action === 'device.add.expire').map((a) => a.detail?.what),
    ).toEqual(['pairing', 'request', 'grant']);
    const s = await svc.status(
      waiting.done.requestId,
      signed(waiting.key, waiting.done.requestId),
      { hubUrl: 'h' },
    );
    expect(s.view).toEqual({ status: 'expired' });
    expect((await rejects(svc.approve(ACCOUNT, waiting.done.requestId, '123456'))).code).toBe(
      'conflict',
    );
  });

  it('expires on access too: a late poll and a late approval', async () => {
    const late = await joined();
    tick(10 * 60_000);
    expect(
      (await rejects(svc.approve(ACCOUNT, late.done.requestId, late.done.confirmation))).code,
    ).toBe('request_expired');
    const poll = await joined();
    tick(10 * 60_000);
    const s = await svc.status(poll.done.requestId, signed(poll.key, poll.done.requestId), {
      hubUrl: 'h',
    });
    expect(s.view).toEqual({ status: 'expired' });
    const grant = await joined();
    await svc.approve(ACCOUNT, grant.done.requestId, grant.done.confirmation);
    tick(10 * 60_000);
    const g = await svc.status(grant.done.requestId, signed(grant.key, grant.done.requestId), {
      hubUrl: 'h',
    });
    expect(g.view).toEqual({ status: 'expired' });
  });

  it('sweeps on an interval until stopped', async () => {
    const quick = new PairingService({
      db,
      events,
      now: () => new Date(clock.now),
      sweepIntervalMs: 5,
    });
    await quick.start(ACCOUNT, { role: 'client' });
    tick(5 * 60_000);
    quick.startSweeper();
    quick.startSweeper();
    for (let i = 0; i < 100; i++) {
      const row = db.raw.prepare('SELECT status FROM device_pairing').get() as { status: string };
      if (row.status === 'expired') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    quick.stopSweeper();
    expect(db.raw.prepare('SELECT status FROM device_pairing').get()).toEqual({
      status: 'expired',
    });
  });
});

describe('revocation', () => {
  it('deletes the sessions, blocks the key and refuses it later', async () => {
    const { key, done } = await joined();
    const approved = await svc.approve(ACCOUNT, done.requestId, done.confirmation);
    const got = await svc.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' });
    const token = got.view.grant?.type === 'session' ? got.view.grant.token : '';
    await svc.revokeDevice(ACCOUNT, approved.deviceId!);
    await svc.revokeDevice(ACCOUNT, approved.deviceId!);
    expect(db.raw.prepare('SELECT count(*) AS n FROM device_session').get()).toEqual({ n: 0 });
    expect(
      db.raw
        .prepare('SELECT count(*) AS n FROM auth_token WHERE token_hash = ?')
        .get(hashToken(token)),
    ).toEqual({ n: 0 });
    expect(await svc.isKeyRevoked(key.publicKey)).toBe(true);
    expect(audit.filter((a) => a.action === 'device.revoke')).toHaveLength(1);
    expect(events.names()).toContain('device.status.changed');
    expect((await svc.summary(ACCOUNT, approved.deviceId!)).status).toBe('revoked');
    expect((await rejects(svc.revokeDevice(OTHER, approved.deviceId!))).code).toBe('not_found');

    const again = await svc.start(ACCOUNT, { role: 'client' });
    const refused = await rejects(
      commit(svc, {
        pairingId: again.pairingId,
        code: again.code,
        publicKey: key.publicKey,
        name: 'Phone',
        platform: 'ios',
        kind: 'browser',
      }),
    );
    expect(refused.code).toBe('policy_denied');
    expect(refused.details).toEqual({ reason: 'key_revoked' });
  });

  it('gives no session to a device revoked while its grant is made (review finding 16)', async () => {
    // The reviewer's probe: the revocation lands between the grant claim and the session insert
    // (the grant awaits the session lifetime setting there).
    let revokeDuring: string | null = null;
    const racing = new PairingService({
      db,
      events,
      now: () => new Date(clock.now),
      settings: {
        sessionDays: async () => {
          if (revokeDuring) await racing.revokeDevice(ACCOUNT, revokeDuring);
          return 7;
        },
      },
    });
    const key = newKey();
    const started = await racing.start(ACCOUNT, { role: 'client' });
    const { done } = await joinWith(racing, started, key);
    const approved = await racing.approve(ACCOUNT, done.requestId, done.confirmation);
    revokeDuring = approved.deviceId;
    const s = await racing.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' });
    expect(s.view).toEqual({ status: 'denied' });
    expect(s.view.grant).toBeUndefined();
    expect(db.raw.prepare('SELECT count(*) AS n FROM device_session').get()).toEqual({ n: 0 });
    expect(
      db.raw.prepare("SELECT count(*) AS n FROM auth_token WHERE kind = 'session'").get(),
    ).toEqual({ n: 0 });
    // Later polls get nothing either.
    tick(1000);
    expect(
      (await racing.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' })).view,
    ).toEqual({ status: 'denied' });
  });

  it('gives nothing to a device revoked before it collected its grant', async () => {
    const { key, done } = await joined();
    const approved = await svc.approve(ACCOUNT, done.requestId, done.confirmation);
    await svc.revokeDevice(ACCOUNT, approved.deviceId!);
    const s = await svc.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' });
    expect(s.view).toEqual({ status: 'denied' });
    expect(db.raw.prepare('SELECT count(*) AS n FROM device_session').get()).toEqual({ n: 0 });

    // Defense in depth: even if the request still says approved, the claim checks the device.
    const b = await joined();
    const ok = await svc.approve(ACCOUNT, b.done.requestId, b.done.confirmation);
    db.raw.prepare("UPDATE device SET status = 'revoked' WHERE id = ?").run(ok.deviceId);
    const sb = await svc.status(b.done.requestId, signed(b.key, b.done.requestId), { hubUrl: 'h' });
    expect(sb.view).toEqual({ status: 'denied' });
    expect(sb.view.grant).toBeUndefined();
  });

  it('refuses an approval when the key was revoked meanwhile, and kills bound tokens', async () => {
    const { done } = await joined();
    const [pending] = await svc.requests(ACCOUNT);
    db.raw
      .prepare(
        "INSERT INTO revoked_device_key (fingerprint, account_id, reason, created_at) VALUES (?, ?, 'revoked', 'x')",
      )
      .run(pending!.fingerprint, ACCOUNT);
    const e = await rejects(svc.approve(ACCOUNT, done.requestId, done.confirmation));
    expect(e.details).toEqual({ reason: 'key_revoked' });

    // A pending novad device with a token handed out: revoking it refuses the token.
    const n = await joined({ kind: 'novad' });
    const approved = await svc.approve(ACCOUNT, n.done.requestId, n.done.confirmation);
    db.raw
      .prepare(
        `INSERT INTO add_device_request (id, account_id, role, code_hash, scopes, status, expires_at, created_at)
         VALUES ('t1', ?, 'client', 'h1', ?, 'pending', '2099-01-01T00:00:00.000Z', 'x')`,
      )
      .run(
        ACCOUNT,
        JSON.stringify({ bind: { publicKey: n.key.publicKey, deviceId: approved.deviceId } }),
      );
    await svc.deviceRevoked(approved.deviceId!, { accountId: OTHER });
    expect(db.raw.prepare("SELECT status FROM add_device_request WHERE id = 't1'").get()).toEqual({
      status: 'pending',
    });
    await svc.revokeDevice(ACCOUNT, approved.deviceId!);
    expect(db.raw.prepare("SELECT status FROM add_device_request WHERE id = 't1'").get()).toEqual({
      status: 'denied',
    });
    await svc.deviceRevoked('01920000-0000-7000-8000-00000000ffff');
  });
});

describe('the Relay seam', () => {
  it('needs a Relay for transport relay', async () => {
    const e = await rejects(svc.start(ACCOUNT, { role: 'client', transport: 'relay' }));
    expect(e.code).toBe('capability_missing');
    expect(e.details).toEqual({ reason: 'relay_unavailable' });
  });

  it('opens a slot, takes a claim by code hash and reports the decision', async () => {
    const opened: Parameters<Parameters<PairingService['useRelayPairing']>[0]>[0][] = [];
    svc.useRelayPairing((input) => {
      opened.push(input);
      return Promise.resolve({ relayUrl: 'wss://relay.example', relayPairingId: 'rp-1' });
    });
    const decided: PairingDecision[] = [];
    svc.onDecided((d) => {
      decided.push(d);
    });
    const started = await svc.start(ACCOUNT, { role: 'client', transport: 'relay' });
    expect(started.relay).toEqual({ relayUrl: 'wss://relay.example', relayPairingId: 'rp-1' });
    expect(opened[0]).toMatchObject({
      pairingId: started.pairingId,
      code: started.code,
      codeHash: pairingCodeHash(started.pairingId, started.code),
    });
    const key = newKey();
    const claim = {
      pairingId: started.pairingId,
      codeHashCheck: pairingCodeHash(started.pairingId, started.code),
      publicKey: key.publicKey,
      name: 'Phone',
      platform: 'android',
      relayClientId: 'client-7',
    };
    const wrong = await rejects(svc.requestFromRelay({ ...claim, codeHashCheck: 'f'.repeat(64) }));
    expect(wrong.code).toBe('auth_missing');
    const out = await svc.requestFromRelay(claim);
    expect(out.confirmation).toBe(
      pairingConfirmation({
        hubFingerprint: '',
        pairingId: started.pairingId,
        publicKey: key.publicKey,
        code: started.code,
      }),
    );
    const [req] = await svc.requests(ACCOUNT);
    expect(req).toMatchObject({ via: 'relay', kind: 'native' });
    await svc.approve(ACCOUNT, out.requestId, out.confirmation);
    expect(decided).toEqual([
      expect.objectContaining({
        requestId: out.requestId,
        decision: 'approved',
        via: 'relay',
        relayClientId: 'client-7',
        publicKey: key.publicKey,
      }),
    ]);
  });

  it('takes the code itself when the Relay area has it, and refuses direct pairings', async () => {
    const opener = () => Promise.resolve({ relayUrl: 'wss://r', relayPairingId: 'rp' });
    svc.useRelayPairing(opener);
    const started = await svc.start(ACCOUNT, { role: 'client', transport: 'relay' });
    // A restarted Hub has lost the kept code: the claim must carry it.
    const restarted = new PairingService({ db, events, now: () => new Date(clock.now) });
    const base = {
      pairingId: started.pairingId,
      codeHashCheck: pairingCodeHash(started.pairingId, started.code),
      publicKey: newKey().publicKey,
      name: 'Tab',
      platform: 'ipados',
      relayClientId: 'c',
      kind: 'browser' as const,
    };
    const lost = await rejects(restarted.requestFromRelay(base));
    expect(lost.code).toBe('auth_missing');
    const withCode = await restarted.requestFromRelay({
      ...base,
      code: started.code.toLowerCase(),
    });
    expect(withCode.confirmation).toMatch(/^\d{6}$/);

    const direct = await svc.start(ACCOUNT, { role: 'client' });
    const refused = await rejects(
      svc.requestFromRelay({
        ...base,
        pairingId: direct.pairingId,
        codeHashCheck: pairingCodeHash(direct.pairingId, direct.code),
      }),
    );
    expect(refused.code).toBe('auth_missing');
    expect((await rejects(svc.requestFromRelay({ ...base, relayClientId: '' }))).code).toBe(
      'validation',
    );
    expect(
      (await rejects(svc.requestFromRelay({ ...base, pairingId: undefined as unknown as string })))
        .code,
    ).toBe('validation');
    expect(
      (await rejects(svc.requestFromRelay({ ...base, kind: 'novad' as unknown as 'browser' })))
        .code,
    ).toBe('validation');
  });
});

describe('the device list and scopes (FR-140)', () => {
  it('lists every device with its sessions and edits scopes', async () => {
    const { key, done } = await joined();
    const approved = await svc.approve(ACCOUNT, done.requestId, done.confirmation);
    await svc.status(done.requestId, signed(key, done.requestId), { hubUrl: 'h' });
    const [item] = await svc.list(ACCOUNT);
    expect(item).toMatchObject({
      id: approved.deviceId,
      name: 'Phone',
      kind: 'client',
      addedAs: 'browser',
      roles: ['client'],
      scopes: ['offline-replica'],
      platform: 'ios',
      status: 'active',
      sessions: 1,
    });
    const next = await svc.setScopes(ACCOUNT, approved.deviceId!, ['local-runtime', 'files']);
    expect(next.scopes).toEqual(['local-runtime', 'files']);
    expect(
      db.raw
        .prepare('SELECT offline_replica, local_runtime FROM device WHERE id = ?')
        .get(approved.deviceId),
    ).toEqual({ offline_replica: 0, local_runtime: 1 });
    expect(audit.at(-1)).toMatchObject({
      action: 'device.scopes.update',
      detail: { from: ['offline-replica'], to: ['local-runtime', 'files'] },
    });
    expect(events.names()).toContain('device.scopes.changed');
    expect((await rejects(svc.summary(OTHER, approved.deviceId!))).code).toBe('not_found');
    await svc.revokeDevice(ACCOUNT, approved.deviceId!);
    expect((await rejects(svc.setScopes(ACCOUNT, approved.deviceId!, []))).code).toBe('conflict');
    expect(await svc.list(OTHER)).toEqual([]);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows the limit per key per window and forgets old keys', () => {
    let now = 0;
    const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => now });
    expect([lim.take('a'), lim.take('a'), lim.take('a')]).toEqual([true, true, false]);
    expect(lim.take('b')).toBe(true);
    now = 1001;
    expect(lim.take('a')).toBe(true);
    lim.take('c');
    expect(lim.size).toBe(2);
    lim.clear();
    expect(lim.size).toBe(0);
  });
});
