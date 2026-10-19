// Web Push for browsers and the PWA (FR-111, docs/13 §6, docs/22 §3.2): the message is encrypted
// to the browser's key (RFC 8291, the `aes128gcm` content coding of RFC 8188) so the push service
// carries ciphertext only, and every request carries a VAPID token (RFC 8292) signed with the
// Hub's P-256 key, so a push service accepts pushes for its subscriptions from this Hub alone.
// Everything is node:crypto (ECDH P-256, HKDF-SHA-256, AES-128-GCM, ES256); nothing is hand-rolled.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { NovaError } from '@nova/shared';
import type { FetchLike } from '../adapters/common.ts';

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text.replace(/=+$/, ''), 'base64url');
}

/** The record size every message uses (one record; RFC 8291 §4 allows any). */
export const RECORD_SIZE = 4096;
/** Header: salt (16) | rs (4) | idlen (1) | keyid (65). */
const HEADER_BYTES = 16 + 4 + 1 + 65;
/** The most plaintext one record holds: rs minus the delimiter and the GCM tag. */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_BYTES - 1 - 16;

export interface SubscriptionKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes). */
  p256dh: Uint8Array;
  /** The 16-byte authentication secret. */
  auth: Uint8Array;
}

export interface EncryptOptions {
  /** Tests (the RFC 8291 example): a fixed salt. */
  salt?: Uint8Array;
  /** Tests: a fixed application server key pair; a fresh one per message otherwise. */
  serverKey?: { privateKey: Uint8Array; publicKey: Uint8Array };
  /** Pad the plaintext to a multiple of this many bytes so its length tells less (0: none). */
  padTo?: number;
}

/** Check a subscription's keys before anything is stored or sent. */
export function subscriptionKeyProblem(keys: SubscriptionKeys): string | null {
  if (keys.auth.length !== 16) return 'the auth secret must be 16 bytes';
  if (keys.p256dh.length !== 65 || keys.p256dh[0] !== 0x04)
    return 'p256dh must be an uncompressed P-256 public key';
  try {
    // ECDH throws for a point that is not on the curve.
    const e = createECDH('prime256v1');
    e.generateKeys();
    e.computeSecret(Buffer.from(keys.p256dh));
  } catch {
    return 'p256dh is not a valid P-256 public key';
  }
  return null;
}

/**
 * RFC 8291 §3.4: the encrypted body (`Content-Encoding: aes128gcm`) of one push message.
 */
export function encryptWebPush(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  opts: EncryptOptions = {},
): Buffer {
  const problem = subscriptionKeyProblem(keys);
  if (problem) throw new NovaError('validation', problem);
  const padTo = opts.padTo ?? 0;
  const padded =
    padTo > 0 ? Math.ceil((plaintext.length + 1) / padTo) * padTo - 1 : plaintext.length;
  const body = Math.min(padded, MAX_PLAINTEXT);
  if (plaintext.length > MAX_PLAINTEXT)
    throw new NovaError('validation', `a push message holds at most ${MAX_PLAINTEXT} bytes`);

  const ecdh = createECDH('prime256v1');
  if (opts.serverKey) ecdh.setPrivateKey(Buffer.from(opts.serverKey.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const uaPublic = Buffer.from(keys.p256dh);
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(keys.auth), keyInfo, 32));
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  );
  // One record: the plaintext, the last-record delimiter 0x02, then zero padding.
  const record = Buffer.alloc(body + 1);
  Buffer.from(plaintext).copy(record);
  record[plaintext.length] = 0x02;
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, ct]);
}

// ---- VAPID (RFC 8292) ---------------------------------------------------------------------------

export interface VapidKeyPair {
  privateKey: KeyObject;
  /** Uncompressed public key (65 bytes). */
  publicKey: Buffer;
}

/** A new P-256 key pair; the private part as a JWK string for the vault. */
export function generateVapidKeys(): { privateJwk: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  return { privateJwk, publicKey: b64url(vapidFromJwk(privateJwk).publicKey) };
}

/** The key pair from the stored JWK (private, with x and y). */
export function vapidFromJwk(jwk: string): VapidKeyPair {
  const parsed = JSON.parse(jwk) as { kty?: string; crv?: string; x?: string; y?: string };
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || !parsed.x || !parsed.y)
    throw new NovaError('server_error', 'the VAPID key is not a P-256 key');
  const privateKey = createPrivateKey({ key: parsed, format: 'jwk' });
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    fromB64url(parsed.x),
    fromB64url(parsed.y),
  ]);
  return { privateKey, publicKey };
}

/**
 * RFC 8292 §2-§3: `vapid t=<JWT>, k=<public key>`. The JWT is ES256 over
 * `{aud: <push service origin>, exp, sub}` and lives at most 24 hours (12 by default).
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeyPair,
  opts: { subject: string; now: Date; ttlSeconds?: number },
): string {
  const ttl = Math.min(opts.ttlSeconds ?? 12 * 3600, 24 * 3600);
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(opts.now.getTime() / 1000) + ttl,
        sub: opts.subject,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${input}.${b64url(sig)}, k=${b64url(keys.publicKey)}`;
}

// ---- delivery ----------------------------------------------------------------------------------

export interface WebPushMessage {
  endpoint: string;
  keys: SubscriptionKeys;
  payload: Uint8Array;
  /** How long the push service keeps it for an offline browser (seconds). */
  ttlSeconds: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic (≤ 32 base64url characters). */
  topic?: string;
}

export interface WebPushResult {
  status: number;
  /** 404 or 410: the subscription no longer exists; forget it. */
  gone: boolean;
  ok: boolean;
  detail: string | null;
}

export interface WebPushSenderOptions {
  vapid: () => Promise<VapidKeyPair>;
  subject: () => Promise<string>;
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  /** Tests only: a fixed salt and server key make the ciphertext reproducible. */
  encrypt?: EncryptOptions;
}

export class WebPushSender {
  readonly #o: WebPushSenderOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(opts: WebPushSenderOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
  }

  async send(msg: WebPushMessage, signal?: AbortSignal): Promise<WebPushResult> {
    const body = encryptWebPush(msg.payload, msg.keys, { padTo: 128, ...this.#o.encrypt });
    const keys = await this.#o.vapid();
    const headers: Record<string, string> = {
      authorization: vapidAuthorization(msg.endpoint, keys, {
        subject: await this.#o.subject(),
        now: this.#now(),
      }),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(Math.max(0, Math.floor(msg.ttlSeconds))),
      urgency: msg.urgency,
    };
    if (msg.topic) headers.topic = msg.topic;
    const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.#fetch(msg.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      return {
        status: 0,
        ok: false,
        gone: false,
        detail:
          `the push service could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            300,
          ),
      };
    }
    // Drain without trusting the body: only a short reason is kept.
    const text = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
    const gone = res.status === 404 || res.status === 410;
    const ok = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      ok,
      gone,
      detail: ok ? null : `HTTP ${res.status}${text ? `: ${text}` : ''}`,
    };
  }
}
