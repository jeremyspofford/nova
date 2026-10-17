// The joining device's pure parts (FR-132; Add Device protocol v2): codes and confirmations match
// the Hub's rules (the fixed v1 vectors of packages/core/test/pairing.test.ts, and the v2
// confirmation, commitment and fingerprint against node:crypto), signatures verify with the
// generated key, the link is read as the Hub writes it, the platform is named, and the status
// poll keeps its spacing and strictly increasing times (fake timers).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  base64url,
  commitment,
  displayConfirmation,
  displayPairingCode,
  exportPublicKey,
  fromBase64url,
  generateDeviceKey,
  hubRevealStatement,
  keyFingerprint,
  normalizeConfirmation,
  normalizePairingCode,
  pairingConfirmation,
  pairingConfirmationV2,
  randomNonce,
  signReveal,
  signStatus,
  statusMessage,
  verifyText,
} from '../src/join/crypto.ts';
import { isJoinPath, joinErrorMessage, readJoinParams } from '../src/join/JoinPage.tsx';
import { detectPlatform, installWay } from '../src/join/platform.ts';
import { POLL_GAP_MS, TimedApiError, pollStatus, type PollAnswer } from '../src/join/poll.ts';
import {
  browserJoinStore,
  memoryJoinStore,
  rememberThisDevice,
  thisDeviceId,
} from '../src/join/store.ts';
import { confirmationV2, hubIdentity } from './fakes-m65-devices.ts';

afterEach(() => {
  vi.useRealTimers();
});

const apiErr = (status: number, code: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message: `raw ${code}`, retryable: false, details });

describe('codes and confirmations (the Hub’s rules)', () => {
  it('reads codes as the Hub does', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ab cd ef gh ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('O1IL-0000')).toBe('01110000');
    expect(normalizePairingCode('ABCD-EFGU')).toBeNull();
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(displayPairingCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(displayPairingCode('nope')).toBe('nope');
    expect(displayConfirmation('123456')).toBe('123 456');
    expect(displayConfirmation('12')).toBe('12');
    expect(normalizeConfirmation('123 456')).toBe('123456');
    expect(normalizeConfirmation('12345')).toBeNull();
  });

  it('matches the fixed v1 vectors of packages/core/test/pairing.test.ts', async () => {
    const base = {
      pairingId: '01920000-0000-7000-8000-00000000aaaa',
      publicKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      code: 'abcd-efgh',
    };
    expect(await pairingConfirmation({ ...base, hubFingerprint: '' })).toBe('894633');
    expect(
      await pairingConfirmation({
        ...base,
        hubFingerprint: 'yAs9pQmQ0Kq6tU1t7mNfLwVd9a4m8Wq3b5r2s1x0z7c',
      }),
    ).toBe('159184');
  });

  it('computes the v2 confirmation, the commitment and the fingerprint like node:crypto', async () => {
    for (let i = 0; i < 5; i++) {
      const f = {
        fingerprint: i % 2 ? '' : 'yAs9pQmQ0Kq6tU1t7mNfLwVd9a4m8Wq3b5r2s1x0z7c',
        pairingId: `01920000-0000-7000-8000-00000000aa${i}0`,
        publicKey: base64url(crypto.getRandomValues(new Uint8Array(32))),
        code: 'ABCDEFGH',
        deviceNonce: randomNonce(),
        hubNonce: randomNonce(),
      };
      expect(
        await pairingConfirmationV2({ ...f, hubFingerprint: f.fingerprint, code: 'abcd-efgh' }),
      ).toBe(confirmationV2(f));
      expect(await commitment(f.publicKey, f.deviceNonce)).toBe(
        createHash('sha256')
          .update(`nova-add-device-commit-v1|${f.publicKey}|${f.deviceNonce}`)
          .digest('base64url'),
      );
    }
    expect(randomNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomNonce()).not.toBe(randomNonce());
    const hub = hubIdentity();
    expect(await keyFingerprint(hub.publicKey)).toBe(hub.fingerprint);
  });

  it('signs with a key it cannot export, and the signature verifies with the public key', async () => {
    const keys = await generateDeviceKey();
    expect(keys.privateKey.extractable).toBe(false);
    const pub = await exportPublicKey(keys.publicKey);
    expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sig = await signStatus(keys.privateKey, 'rq1', 1_700_000_000);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // node:crypto, as the Hub verifies it.
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
    expect(
      verify(
        null,
        Buffer.from(statusMessage('rq1', 1_700_000_000)),
        key,
        Buffer.from(sig, 'base64url'),
      ),
    ).toBe(true);
    expect(await verifyText(pub, statusMessage('rq1', 1_700_000_000), sig)).toBe(true);
    expect(await verifyText(pub, statusMessage('rq1', 1_700_000_001), sig)).toBe(false);
    const reveal = await signReveal(keys.privateKey, 'rq1', 5);
    expect(await verifyText(pub, 'nova-add-device-reveal-v1.rq1.5', reveal)).toBe(true);
    expect(await verifyText('not a key', 'x', reveal)).toBe(false);
    expect(
      hubRevealStatement({ requestId: 'r', pairingId: 'p', publicKey: 'k', confirmation: '1' }),
    ).toBe('nova-add-device-reveal-v1|r|p|k|1');
    expect([...fromBase64url(base64url(new Uint8Array([1, 2, 250])))]).toEqual([1, 2, 250]);
  });
});

describe('the link and the platform', () => {
  it('reads the pairing, the pin and the code from the link', () => {
    expect(isJoinPath('/add-device')).toBe(true);
    expect(isJoinPath('/add-device/')).toBe(true);
    expect(isJoinPath('/devices/add')).toBe(false);
    expect(readJoinParams('?p=pr1&fp=abc&e=http%3A%2F%2Fx', '#c=ABCD-EFGH')).toEqual({
      pairingId: 'pr1',
      fingerprint: 'abc',
      code: 'ABCDEFGH',
      badCode: false,
    });
    expect(readJoinParams('', '')).toEqual({
      pairingId: null,
      fingerprint: null,
      code: null,
      badCode: false,
    });
    expect(readJoinParams('?p=../x', '#c=nope')).toEqual({
      pairingId: null,
      fingerprint: null,
      code: null,
      badCode: true,
    });
    expect(readJoinParams('', '#c=%E0%A4%A').badCode).toBe(true);
  });

  it('names the device from its user agent and says how to install', () => {
    const iphone = detectPlatform(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    );
    expect(iphone).toEqual({
      os: 'ios',
      browser: 'safari',
      name: 'Safari on iPhone',
      platform: 'iOS',
    });
    expect(installWay(iphone, false)).toBe('ios-share');
    const ipad = detectPlatform(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      5,
    );
    expect(ipad.name).toBe('Safari on iPad');
    const android = detectPlatform(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
    );
    expect(android.name).toBe('Chrome on Android');
    expect(installWay(android, true)).toBe('prompt');
    expect(installWay(android, false)).toBe('menu');
    const edge = detectPlatform(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
    );
    expect(edge).toMatchObject({ name: 'Edge on Windows', platform: 'Windows' });
    const firefox = detectPlatform(
      'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    );
    expect(firefox.name).toBe('Firefox on Linux');
    expect(installWay(firefox, false)).toBe('none');
    expect(detectPlatform('Mozilla/5.0 (X11; CrOS x86_64) Chrome/140.0').platform).toBe('ChromeOS');
    expect(detectPlatform('Mozilla/5.0 (Macintosh) Safari/605').name).toBe('Safari on Mac');
    expect(detectPlatform('SamsungBrowser/25 Android').name).toBe('Samsung Internet on Android');
    expect(detectPlatform('curl/8')).toMatchObject({ name: 'Web browser', platform: 'Unknown' });
  });

  it('says what went wrong in plain words', () => {
    expect(
      joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 3 })),
    ).toBe('That code is not right. 3 tries left.');
    expect(
      joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 1 })),
    ).toBe('That code is not right. 1 try left.');
    expect(
      joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'wrong_code', attemptsLeft: 0 })),
    ).toMatch(/stopped accepting it/);
    expect(joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'wrong_code' }))).toMatch(
      /Check it/,
    );
    expect(joinErrorMessage(apiErr(410, 'request_expired', { reason: 'expired' }))).toMatch(
      /expired/,
    );
    expect(joinErrorMessage(apiErr(400, 'validation', { reason: 'kind_not_allowed' }))).toMatch(
      /compute node or a Wake helper/,
    );
    expect(joinErrorMessage(apiErr(403, 'policy_denied', { reason: 'key_revoked' }))).toMatch(
      /revoked/,
    );
    expect(joinErrorMessage(apiErr(409, 'conflict', { reason: 'key_in_use' }))).toMatch(
      /already added/,
    );
    expect(
      joinErrorMessage(apiErr(403, 'policy_denied', { reason: 'add_device_disabled' })),
    ).toMatch(/turned off/);
    expect(joinErrorMessage(apiErr(429, 'rate_limited'))).toMatch(/Too many tries/);
    expect(joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'bad_signature' }))).toMatch(
      /signature/,
    );
    expect(joinErrorMessage(apiErr(401, 'auth_missing', { reason: 'bad_reveal' }))).toMatch(
      /dropped/,
    );
    expect(joinErrorMessage(apiErr(409, 'conflict', { reason: 'already_revealed' }))).toMatch(
      /already answered/,
    );
    expect(joinErrorMessage(apiErr(500, 'x'))).toBe('raw x');
    expect(joinErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
  });
});

describe('the join store', () => {
  it('keeps the request in memory without IndexedDB, and remembers this device', async () => {
    const keys = await generateDeviceKey();
    const store = browserJoinStore(undefined);
    expect(await store.load()).toBeNull();
    const rec = {
      pairingId: 'p',
      requestId: 'r',
      confirmation: '123456',
      expiresAt: 'x',
      name: 'n',
      keys,
      lastTime: 1,
    };
    await store.save(rec);
    expect(await store.load()).toBe(rec);
    await store.clear();
    expect(await store.load()).toBeNull();
    // A broken IndexedDB falls back to memory.
    const broken = browserJoinStore({
      open: () => {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory);
    await broken.save(rec);
    expect(await broken.load()).toBe(rec);
    await broken.clear();
    expect(await memoryJoinStore(rec).load()).toBe(rec);
    rememberThisDevice('dev-1');
    expect(thisDeviceId()).toBe('dev-1');
    window.localStorage.removeItem('nova.device.id');
  });
});

describe('the status poll (docs/22 §4.1)', () => {
  const pending: PollAnswer = { body: { status: 'pending' }, hubTime: null };

  it('waits 2 s between polls and signs strictly increasing times', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_700_000_000_500 });
    const sent: { time: number; at: number }[] = [];
    let n = 0;
    const out = pollStatus(
      {
        poll: (time) => {
          sent.push({ time, at: Date.now() });
          n++;
          if (n === 2) return Promise.reject(apiErr(401, 'auth_missing', { reason: 'replayed' }));
          return Promise.resolve(
            n < 6 ? pending : { body: { status: 'approved', deviceId: 'd1' }, hubTime: null },
          );
        },
      },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(out).resolves.toEqual({
      status: 'approved',
      view: { status: 'approved', deviceId: 'd1' },
    });
    expect(sent).toHaveLength(6);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(POLL_GAP_MS);
      expect(sent[i]!.time).toBeGreaterThan(sent[i - 1]!.time);
    }
    expect(sent[0]!.time).toBe(1_700_000_000);
  });

  it('starts after the last accepted time, follows the Hub clock and backs off without it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000_000_000 });
    const sent: { time: number; at: number }[] = [];
    const offline: boolean[] = [];
    let n = 0;
    const out = pollStatus(
      {
        lastTime: 2_000_000_000,
        onProgress: (p) => offline.push(p.offline),
        poll: (time) => {
          sent.push({ time, at: Date.now() });
          n++;
          if (n === 1)
            return Promise.resolve({ body: { status: 'pending' }, hubTime: 1_000_000_100_000 });
          if (n === 2) return Promise.reject(new TypeError('Failed to fetch'));
          if (n === 3)
            return Promise.reject(
              new TimedApiError(
                apiErr(401, 'auth_missing', { reason: 'stale_time' }),
                1_000_000_500_000,
              ),
            );
          if (n === 4) return Promise.reject(apiErr(429, 'rate_limited', { retryAfterMs: 12_000 }));
          return Promise.resolve({ body: { status: 'denied' }, hubTime: null });
        },
      },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(out).resolves.toMatchObject({ status: 'denied' });
    // After a reload: later than the last accepted time.
    expect(sent[0]!.time).toBe(2_000_000_001);
    // A lost connection waits 4 s (backoff), a refusal for rate waits at least 12 s.
    expect(sent[2]!.at - sent[1]!.at).toBe(2 * POLL_GAP_MS);
    expect(sent[4]!.at - sent[3]!.at).toBeGreaterThanOrEqual(12_000);
    expect(offline).toContain(true);
    // Every time is later than the one before.
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.time).toBeGreaterThan(sent[i - 1]!.time);
  });

  it('stops on a refusal that cannot get better, and when aborted', async () => {
    const failed = await pollStatus(
      {
        poll: () => Promise.reject(apiErr(401, 'auth_missing', { reason: 'bad_signature' })),
        wait: () => Promise.resolve(),
      },
      new AbortController().signal,
    );
    expect(failed.status).toBe('failed');
    const ctl = new AbortController();
    const stopped = pollStatus(
      {
        poll: () => {
          ctl.abort();
          return Promise.resolve(pending);
        },
        wait: () => Promise.resolve(),
      },
      ctl.signal,
    );
    await expect(stopped).resolves.toEqual({ status: 'stopped' });
  });
});
