// Sealing and pairing cryptography (FR-137, docs/22 §3.1, ADR-094): the round trip, tampering with
// each associated-data field and with ct, per-direction keys, the X25519 binding signatures, the
// code-derived secrets and the confirmation code.
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  associatedData,
  bindingBytes,
  confirmationCode,
  createClaim,
  createOffer,
  deriveSessionKeys,
  exportX25519Private,
  fromBase64,
  generateEd25519,
  generateX25519,
  importX25519Private,
  importX25519PrivateKey,
  keyFingerprint,
  normalizePairingCode,
  open,
  openClaim,
  openOffer,
  pairingSecrets,
  seal,
  toBase64,
  toBase64Url,
  utf8,
  verifyEd25519,
} from '../src/index.ts';

const ITER = 1_000;
const bind = (client: string, stream: string, seq: number, i: number, n: number) =>
  associatedData({ client, stream, seq, seg: { i, n } });

async function pairKeys() {
  const hub = await generateX25519();
  const client = await generateX25519();
  const binding = {
    hubRoute: 'HUBROUTE00000000',
    clientRoute: 'CLIENTROUTE00000',
    clientId: 'client-1',
    hubX25519: hub.publicKey,
    clientX25519: client.publicKey,
  };
  return {
    hub: await deriveSessionKeys('hub', hub.privateKey, binding),
    client: await deriveSessionKeys('client', client.privateKey, binding),
    binding,
    hubPair: hub,
    clientPair: client,
  };
}

describe('sealing', () => {
  it('round-trips and fails on any change to the associated data or ct', async () => {
    const { hub, client } = await pairKeys();
    const ad = bind('client-1', 'c1', 3, 1, 2);
    const ct = seal(hub.send, utf8('hello'), ad);
    expect(new TextDecoder().decode(open(client.recv, ct, ad) ?? undefined)).toBe('hello');
    expect(open(client.recv, ct, bind('client-2', 'c1', 3, 1, 2))).toBeNull();
    expect(open(client.recv, ct, bind('client-1', 'c2', 3, 1, 2))).toBeNull();
    expect(open(client.recv, ct, bind('client-1', 'c1', 4, 1, 2))).toBeNull();
    expect(open(client.recv, ct, bind('client-1', 'c1', 3, 0, 2))).toBeNull();
    expect(open(client.recv, ct, bind('client-1', 'c1', 3, 1, 3))).toBeNull();
    const bytes = fromBase64(ct);
    for (const at of [0, 23, 24, bytes.length - 1]) {
      const t = bytes.slice();
      t[at]! ^= 1;
      expect(open(client.recv, toBase64(t), ad), `byte ${at}`).toBeNull();
    }
    expect(open(client.recv, 'not base64', ad)).toBeNull();
    expect(open(client.recv, toBase64(new Uint8Array(30)), ad)).toBeNull();
  });

  it('derives the same per-direction keys on both sides, different per direction', async () => {
    const { hub, client } = await pairKeys();
    expect(hub.send).toEqual(client.recv);
    expect(hub.recv).toEqual(client.send);
    expect(hub.send).not.toEqual(hub.recv);
    // A frame reflected back to its sender does not open.
    const ad = bind('client-1', 'c1', 1, 0, 1);
    expect(open(hub.recv, seal(hub.send, utf8('x'), ad), ad)).toBeNull();
  });

  it('binds the routing ids and keys into the session keys', async () => {
    const hub = await generateX25519();
    const client = await generateX25519();
    const base = {
      hubRoute: 'HUBROUTE00000000',
      clientRoute: 'CLIENTROUTE00000',
      clientId: 'client-1',
      hubX25519: hub.publicKey,
      clientX25519: client.publicKey,
    };
    const k1 = await deriveSessionKeys('hub', hub.privateKey, base);
    const k2 = await deriveSessionKeys('hub', hub.privateKey, {
      ...base,
      clientRoute: 'OTHERROUTE000000',
    });
    expect(k1.send).not.toEqual(k2.send);
  });

  it('imports the private key alone as not extractable', async () => {
    const pair = await generateX25519();
    const key = await importX25519PrivateKey(await exportX25519Private(pair.privateKey));
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', key)).rejects.toThrow();
    const peer = await generateX25519();
    const b = {
      hubRoute: 'HUBROUTE00000000',
      clientRoute: 'CLIENTROUTE00000',
      clientId: 'c',
      hubX25519: pair.publicKey,
      clientX25519: peer.publicKey,
    };
    expect((await deriveSessionKeys('hub', key, b)).send).toEqual(
      (await deriveSessionKeys('hub', pair.privateKey, b)).send,
    );
  });

  it('exports and re-imports an X25519 key', async () => {
    const pair = await generateX25519();
    const again = await importX25519Private(await exportX25519Private(pair.privateKey));
    expect(again.publicKey).toBe(pair.publicKey);
    const peer = await generateX25519();
    const b = {
      hubRoute: 'HUBROUTE00000000',
      clientRoute: 'CLIENTROUTE00000',
      clientId: 'c',
      hubX25519: pair.publicKey,
      clientX25519: peer.publicKey,
    };
    expect((await deriveSessionKeys('hub', again.privateKey, b)).send).toEqual(
      (await deriveSessionKeys('hub', pair.privateKey, b)).send,
    );
    await expect(
      deriveSessionKeys('hub', pair.privateKey, { ...b, clientX25519: 'short' }),
    ).rejects.toThrow();
  });
});

describe('Ed25519 and fingerprints', () => {
  it('signs and verifies, and matches node:crypto', async () => {
    const id = await generateEd25519();
    const msg = utf8('m');
    const sig = await id.sign(msg);
    expect(await verifyEd25519(id.publicKey, msg, sig)).toBe(true);
    expect(await verifyEd25519(id.publicKey, utf8('n'), sig)).toBe(false);
    expect(await verifyEd25519('bad', msg, sig)).toBe(false);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' }).x!;
    const nodeSig = nodeSign(null, Buffer.from(msg), privateKey);
    expect(await verifyEd25519(raw, msg, new Uint8Array(nodeSig))).toBe(true);
    expect(await keyFingerprint(raw)).toBe(
      createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url'),
    );
  });
});

describe('pairing secrets, offer and claim', () => {
  it('normalizes codes like the Add Device service', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' o1il 2345 ')).toBe('011123 45'.replace(' ', ''));
  });

  it('derives the same secrets from the same code and pairing id only', async () => {
    const a = await pairingSecrets('ABCD-EFGH', 'pairing-1', ITER);
    const b = await pairingSecrets('abcdefgh', 'pairing-1', ITER);
    const c = await pairingSecrets('ABCD-EFGJ', 'pairing-1', ITER);
    const d = await pairingSecrets('ABCD-EFGH', 'pairing-2', ITER);
    expect(a.codeHash).toBe(b.codeHash);
    expect(a.claimKey).toEqual(b.claimKey);
    expect(a.codeHash).not.toBe(c.codeHash);
    expect(a.codeHash).not.toBe(d.codeHash);
    expect(a.codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The hash reveals neither key.
    expect(a.offerKey).not.toEqual(a.claimKey);
  });

  it('carries the Hub offer to a client that knows the code, signed and pinned', async () => {
    const s = await pairingSecrets('ABCD-EFGH', 'pairing-1', ITER);
    const identity = await generateEd25519();
    const x = await generateX25519();
    const sealed = await createOffer({
      offerKey: s.offerKey,
      relayPairingId: 'pairing-1',
      hubRoute: 'HUBROUTE00000000',
      x25519: x.publicKey,
      addPairingId: 'add-1',
      identity,
    });
    const pin = await keyFingerprint(identity.publicKey);
    const offer = await openOffer({
      offerKey: s.offerKey,
      relayPairingId: 'pairing-1',
      sealed,
      hubRoute: 'HUBROUTE00000000',
      pin,
    });
    expect(offer).toMatchObject({ x25519: x.publicKey, addPairingId: 'add-1', fingerprint: pin });
    const wrong = await pairingSecrets('ABCD-EFGJ', 'pairing-1', ITER);
    await expect(
      openOffer({
        offerKey: wrong.offerKey,
        relayPairingId: 'pairing-1',
        sealed,
        hubRoute: 'HUBROUTE00000000',
      }),
    ).rejects.toThrow('does not open');
    await expect(
      openOffer({
        offerKey: s.offerKey,
        relayPairingId: 'pairing-1',
        sealed,
        hubRoute: 'OTHERROUTE000000',
      }),
    ).rejects.toThrow('malformed');
    await expect(
      openOffer({
        offerKey: s.offerKey,
        relayPairingId: 'pairing-1',
        sealed,
        hubRoute: 'HUBROUTE00000000',
        pin: 'another-fingerprint',
      }),
    ).rejects.toThrow('pinned');
    // A Hub without an identity key cannot satisfy a pin.
    const plain = await createOffer({
      offerKey: s.offerKey,
      relayPairingId: 'pairing-1',
      hubRoute: 'HUBROUTE00000000',
      x25519: x.publicKey,
      addPairingId: 'add-1',
    });
    const o2 = await openOffer({
      offerKey: s.offerKey,
      relayPairingId: 'pairing-1',
      sealed: plain,
      hubRoute: 'HUBROUTE00000000',
    });
    expect(o2.fingerprint).toBeNull();
    await expect(
      openOffer({
        offerKey: s.offerKey,
        relayPairingId: 'pairing-1',
        sealed: plain,
        hubRoute: 'HUBROUTE00000000',
        pin,
      }),
    ).rejects.toThrow('pinned');
  });

  it('refuses an offer whose signature is not the identity key’s', async () => {
    const s = await pairingSecrets('ABCD-EFGH', 'p', ITER);
    const identity = await generateEd25519();
    const other = await generateEd25519();
    const x = await generateX25519();
    const forged = await createOffer({
      offerKey: s.offerKey,
      relayPairingId: 'p',
      hubRoute: 'HUBROUTE00000000',
      x25519: x.publicKey,
      addPairingId: 'add-1',
      identity: { publicKey: identity.publicKey, sign: (b) => other.sign(b) },
    });
    await expect(
      openOffer({
        offerKey: s.offerKey,
        relayPairingId: 'p',
        sealed: forged,
        hubRoute: 'HUBROUTE00000000',
      }),
    ).rejects.toThrow('signature');
  });

  it('carries the client claim to the Hub and checks its binding signature', async () => {
    const s = await pairingSecrets('ABCD-EFGH', 'p', ITER);
    const device = await generateEd25519();
    const x = await generateX25519();
    const sealed = await createClaim({
      claimKey: s.claimKey,
      relayPairingId: 'p',
      code: 'abcd-efgh',
      device,
      x25519: x.publicKey,
      name: 'Phone',
      platform: 'ios',
      kind: 'native',
    });
    const claim = await openClaim(s.claimKey, 'p', sealed);
    expect(claim).toMatchObject({
      code: 'ABCDEFGH',
      publicKey: device.publicKey,
      x25519: x.publicKey,
      kind: 'native',
    });
    expect(await openClaim(s.offerKey, 'p', sealed)).toBeNull();
    expect(await openClaim(s.claimKey, 'q', sealed)).toBeNull();
    // A claim whose X25519 key the device key did not sign is refused.
    const other = await generateEd25519();
    const forged = await createClaim({
      claimKey: s.claimKey,
      relayPairingId: 'p',
      code: 'abcd-efgh',
      device: { publicKey: device.publicKey, sign: (b) => other.sign(b) },
      x25519: x.publicKey,
      name: 'Phone',
      platform: 'ios',
      kind: 'native',
    });
    expect(await openClaim(s.claimKey, 'p', forged)).toBeNull();
    // Malformed content inside a valid seal is refused too.
    expect(
      await openClaim(s.claimKey, 'p', seal(s.claimKey, utf8('[]'), utf8('nova-relay-claim-v1|p'))),
    ).toBeNull();
    expect(
      await openClaim(s.claimKey, 'p', seal(s.claimKey, utf8('{'), utf8('nova-relay-claim-v1|p'))),
    ).toBeNull();
    expect(
      await openClaim(
        s.claimKey,
        'p',
        seal(s.claimKey, utf8(JSON.stringify({ v: 1, code: 'X' })), utf8('nova-relay-claim-v1|p')),
      ),
    ).toBeNull();
    expect(bindingBytes('client', x.publicKey, 'p')).toEqual(
      bindingBytes('client', x.publicKey, 'p', ''),
    );
  });

  it('computes the confirmation code as specified (a fixed vector)', async () => {
    const input = {
      hubFingerprint: 'fp',
      pairingId: 'pairing',
      publicKey: 'key',
      code: 'abcd-efgh',
    };
    const digest = createHash('sha256')
      .update('nova-add-device-v1|fp|pairing|key|ABCDEFGH')
      .digest();
    const expected = (BigInt(`0x${digest.toString('hex')}`) % 1_000_000n)
      .toString()
      .padStart(6, '0');
    expect(await confirmationCode(input)).toBe(expected);
    expect(await confirmationCode({ ...input, hubFingerprint: null })).toBe(
      (
        BigInt(
          `0x${createHash('sha256').update('nova-add-device-v1||pairing|key|ABCDEFGH').digest('hex')}`,
        ) % 1_000_000n
      )
        .toString()
        .padStart(6, '0'),
    );
    expect(toBase64Url(new Uint8Array([255]))).toBe('_w');
  });
});
