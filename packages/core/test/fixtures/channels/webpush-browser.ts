// The browser's side of Web Push for the tests (RFC 8291 §3.4 in reverse): a P-256 key pair and
// auth secret like a PushSubscription's, and decryption of an `aes128gcm` body with them.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

export interface FakeBrowser {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  decrypt(body: Uint8Array): Buffer;
}

export function fakeBrowser(endpoint: string): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt: (body) => decryptWebPush(Buffer.from(body), ecdh.getPrivateKey(), auth),
  };
}

/** The browser's side (RFC 8291 §3.4 in reverse): decrypt a body with the UA private key. */
export function decryptWebPush(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const record = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 0x02) throw new Error('not a last record');
  return record.subarray(0, end);
}
