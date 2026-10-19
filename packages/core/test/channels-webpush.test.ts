// Web Push crypto (FR-111, docs/13 §6): RFC 8291 message encryption reproduces the RFC's own
// example byte for byte and decrypts with the browser's key; RFC 8292 VAPID tokens verify with the
// public key, name the push service's origin and expire within 24 hours; and the sender posts the
// encrypted body with the VAPID header and recognises a gone subscription.
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PLAINTEXT,
  WebPushSender,
  b64url,
  encryptWebPush,
  fromB64url,
  generateVapidKeys,
  subscriptionKeyProblem,
  vapidAuthorization,
  vapidFromJwk,
} from '../src/channels/push/webpush.ts';
import { decryptWebPush } from './fixtures/channels/webpush-browser.ts';

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const keys = () => ({ p256dh: fromB64url(RFC.uaPublic), auth: fromB64url(RFC.auth) });

describe('RFC 8291 message encryption', () => {
  it('reproduces the RFC example byte for byte', () => {
    const out = encryptWebPush(fromB64url(RFC.plaintext), keys(), {
      salt: fromB64url(RFC.salt),
      serverKey: { privateKey: fromB64url(RFC.asPrivate), publicKey: fromB64url(RFC.asPublic) },
    });
    expect(b64url(out)).toBe(RFC.body);
    expect(out.readUInt32BE(16)).toBe(4096);
  });

  it('decrypts with the browser key, pads to hide the length, and uses a fresh key each time', () => {
    const msg = Buffer.from('{"v":1,"title":"Approval needed"}');
    const a = encryptWebPush(msg, keys(), { padTo: 128 });
    const b = encryptWebPush(msg, keys(), { padTo: 128 });
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    // 86 header + 127 padded plaintext + delimiter + 16 tag.
    expect(a.length).toBe(86 + 128 + 16);
    expect(decryptWebPush(a, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth)).toString()).toBe(
      msg.toString(),
    );
  });

  it('refuses bad subscription keys and oversized messages', () => {
    expect(
      subscriptionKeyProblem({ p256dh: fromB64url(RFC.uaPublic), auth: Buffer.alloc(8) }),
    ).toMatch(/16 bytes/);
    expect(subscriptionKeyProblem({ p256dh: Buffer.alloc(65), auth: Buffer.alloc(16) })).toMatch(
      /uncompressed/,
    );
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 4;
    expect(subscriptionKeyProblem({ p256dh: offCurve, auth: Buffer.alloc(16) })).toMatch(/valid/);
    expect(() => encryptWebPush(Buffer.alloc(MAX_PLAINTEXT + 1), keys())).toThrow(/at most/);
  });
});

describe('RFC 8292 VAPID', () => {
  it('signs an ES256 token the public key verifies, for the push service origin', () => {
    const generated = generateVapidKeys();
    const pair = vapidFromJwk(generated.privateJwk);
    expect(b64url(pair.publicKey)).toBe(generated.publicKey);
    expect(pair.publicKey.length).toBe(65);
    const now = new Date('2026-10-17T12:00:00Z');
    const header = vapidAuthorization('https://push.example.com/send/abc?x=1', pair, {
      subject: 'mailto:owner@example.com',
      now,
    });
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m as unknown as [string, string, string, string, string];
    expect(k).toBe(generated.publicKey);
    expect(JSON.parse(fromB64url(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromB64url(c).toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://push.example.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: 'mailto:owner@example.com',
    });
    const raw = fromB64url(k);
    const pub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(raw.subarray(1, 33)),
        y: b64url(raw.subarray(33)),
      },
      format: 'jwk',
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: pub, dsaEncoding: 'ieee-p1363' },
      fromB64url(s),
    );
    expect(ok).toBe(true);
    // Another key does not verify it.
    const other = vapidFromJwk(generateVapidKeys().privateJwk);
    const otherPub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url(other.publicKey.subarray(1, 33)),
        y: b64url(other.publicKey.subarray(33)),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: otherPub, dsaEncoding: 'ieee-p1363' },
        fromB64url(s),
      ),
    ).toBe(false);
    // Never more than 24 hours.
    const long = vapidAuthorization('https://push.example.com/x', pair, {
      subject: 'mailto:a@b.c',
      now,
      ttlSeconds: 7 * 86400,
    });
    const longClaims = JSON.parse(fromB64url(long.split('.')[1]!).toString()) as { exp: number };
    expect(longClaims.exp).toBe(Math.floor(now.getTime() / 1000) + 86400);
  });

  it('refuses a stored key that is not P-256', () => {
    expect(() => vapidFromJwk(JSON.stringify({ kty: 'RSA' }))).toThrow(/P-256/);
  });
});

describe('the sender', () => {
  it('posts the encrypted body with VAPID and push headers, and reports a gone subscription', async () => {
    const pair = vapidFromJwk(generateVapidKeys().privateJwk);
    const seen: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const sender = new WebPushSender({
      vapid: () => Promise.resolve(pair),
      subject: () => Promise.resolve('mailto:o@example.com'),
      now: () => new Date('2026-10-17T12:00:00Z'),
      fetch: (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(new Response(status === 410 ? 'gone' : null, { status }));
      },
    });
    const msg = {
      endpoint: 'https://push.example.com/s/1',
      keys: keys(),
      payload: Buffer.from('hello'),
      ttlSeconds: 3600,
      urgency: 'high' as const,
      topic: 'n1',
    };
    expect(await sender.send(msg)).toEqual({ status: 201, ok: true, gone: false, detail: null });
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(h).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '3600',
      urgency: 'high',
      topic: 'n1',
    });
    expect(h.authorization).toMatch(/^vapid t=.+, k=/);
    const body = seen[0]!.init.body as Buffer;
    expect(decryptWebPush(body, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth)).toString()).toBe(
      'hello',
    );
    status = 410;
    expect(await sender.send(msg)).toMatchObject({ status: 410, gone: true, ok: false });
    const failing = new WebPushSender({
      vapid: () => Promise.resolve(pair),
      subject: () => Promise.resolve('mailto:o@example.com'),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await failing.send(msg)).toMatchObject({ status: 0, ok: false, gone: false });
  });
});
