import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  certificateDecision,
  certificatesFromPem,
  certificateSha256,
  checkStatement,
  fingerprintOf,
  pinnedTrust,
  verifyHubIdentity,
} from '../src/pinning.ts';
import { listed, makeIdentity, makePki, sha256, statement } from './fixtures.ts';

const NONCE = 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U';
const pki = makePki(['127.0.0.1', 'hub.example.internal']);
const id = makeIdentity();
const chain = [pki.leaf, pki.ca];

describe('verifyHubIdentity (docs/22 §5 steps 4-6)', () => {
  it('trusts the listed leaf presented with the pinned key and this nonce', () => {
    const s = statement(id, NONCE, listed(pki));
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain,
      }),
    ).toEqual({ result: 'trusted', via: 'listed' });
  });

  it('trusts a server certificate of the listed CA for the dialed host', () => {
    const s = statement(id, NONCE, [listed(pki)[0]!]);
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: 'hub.example.internal',
        chain,
      }),
    ).toEqual({ result: 'trusted', via: 'ca' });
  });

  it('refuses another key, even one whose statement is internally consistent', () => {
    const other = makeIdentity();
    const s = statement(other, NONCE, listed(pki));
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain,
      }),
    ).toEqual({ result: 'refused', reason: 'pin_mismatch' });
  });

  it('refuses a statement whose fingerprint claims the pin for another key', () => {
    const other = makeIdentity();
    const s = statement(other, NONCE, listed(pki), { hubFingerprint: id.fingerprint });
    expect(checkStatement(s, id.fingerprint, NONCE)).toBe('pin_mismatch');
  });

  it('refuses a key that is not 32 raw bytes', () => {
    const s = { ...statement(id, NONCE, listed(pki)), hubPublicKey: 'AAAA' };
    expect(checkStatement(s, id.fingerprint, NONCE)).toBe('pin_mismatch');
  });

  it('refuses a tampered statement', () => {
    const s = statement(id, NONCE, listed(pki));
    const tampered = {
      ...s,
      certificates: [
        { kind: 'leaf' as const, sha256: sha256(pki.strangerPem), notAfter: s.issuedAt },
      ],
    };
    expect(checkStatement(tampered, id.fingerprint, NONCE)).toBe('bad_signature');
    expect(checkStatement({ ...s, signature: '!!' }, id.fingerprint, NONCE)).toBe('bad_signature');
  });

  it('refuses a replayed statement (another nonce)', () => {
    const s = statement(id, 'b2xkLW9sZC1vbGQtb2xkLW9sZC1vbGQ', listed(pki));
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain,
      }),
    ).toEqual({ result: 'refused', reason: 'nonce_mismatch' });
  });

  it('defers to the platform roots when the owner turned pinning off', () => {
    const s = statement(id, NONCE, listed(pki), { pinning: 'off' });
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain: [],
      }),
    ).toEqual({ result: 'use_platform_roots' });
  });

  it('refuses when no certificate was presented', () => {
    const s = statement(id, NONCE, listed(pki));
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain: [],
      }),
    ).toEqual({ result: 'refused', reason: 'no_certificate' });
  });

  it('refuses a certificate from another CA (an interceptor)', () => {
    const s = statement(id, NONCE, listed(pki));
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain: [pki.stranger, pki.ca],
      }),
    ).toEqual({ result: 'refused', reason: 'not_listed' });
  });

  it('never accepts a device certificate (client-only), even from the listed CA', () => {
    const s = statement(id, NONCE, [listed(pki)[0]!]);
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain: [pki.device, pki.ca],
      }),
    ).toEqual({ result: 'refused', reason: 'not_server_certificate' });
  });

  it('refuses a CA leaf for a host it does not name', () => {
    const s = statement(id, NONCE, [listed(pki)[0]!]);
    expect(
      verifyHubIdentity({
        statement: s,
        pin: id.fingerprint,
        nonce: NONCE,
        host: 'evil.example',
        chain,
      }),
    ).toEqual({ result: 'refused', reason: 'host_mismatch' });
  });

  it('refuses an expired certificate, listed or issued', () => {
    const later = new Date(Date.now() + 400 * 86_400_000);
    expect(
      verifyHubIdentity({
        statement: statement(id, NONCE, listed(pki)),
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain,
        now: later,
      }),
    ).toEqual({ result: 'refused', reason: 'expired' });
    expect(
      verifyHubIdentity({
        statement: statement(id, NONCE, [listed(pki)[0]!]),
        pin: id.fingerprint,
        nonce: NONCE,
        host: '127.0.0.1',
        chain,
        now: later,
      }),
    ).toEqual({ result: 'refused', reason: 'expired' });
  });
});

describe('later connections (docs/22 §5 step 7)', () => {
  const trust = pinnedTrust(statement(id, NONCE, listed(pki)), chain, '127.0.0.1');

  it('keeps the listed hashes and the CA certificate', () => {
    expect(trust.listed).toEqual([sha256(pki.leafPem)]);
    expect(trust.caSha256).toBe(sha256(pki.caPem));
    expect(trust.caPem).toContain('BEGIN CERTIFICATE');
  });

  it('accepts the listed leaf, and a leaf of the listed CA even when the chain omits the CA', () => {
    expect(certificateDecision([pki.leaf], '127.0.0.1', trust)).toBe('accept');
    const onlyCa = { ...trust, listed: [] };
    expect(certificateDecision([pki.leaf], '127.0.0.1', onlyCa)).toBe('accept');
    const elsewhere = makePki(['127.0.0.1']);
    expect(certificateDecision([elsewhere.leaf, elsewhere.ca], '127.0.0.1', onlyCa)).toBe(
      'unknown',
    );
  });

  it('asks again for anything else', () => {
    expect(certificateDecision([pki.stranger], '127.0.0.1', trust)).toBe('unknown');
    expect(certificateDecision([pki.device, pki.ca], '127.0.0.1', { ...trust, listed: [] })).toBe(
      'unknown',
    );
    expect(certificateDecision([pki.leaf], 'other.host', trust)).toBe('unknown');
    expect(certificateDecision([], '127.0.0.1', trust)).toBe('unknown');
    expect(
      certificateDecision([pki.leaf], '127.0.0.1', trust, new Date(Date.now() + 400 * 86_400_000)),
    ).toBe('unknown');
    expect(
      certificateDecision([pki.leaf], '127.0.0.1', { ...trust, listed: [], caSha256: null }),
    ).toBe('unknown');
    expect(
      certificateDecision([pki.leaf], '127.0.0.1', { ...trust, listed: [], caPem: 'damaged' }),
    ).toBe('unknown');
  });

  it('keeps no CA when the statement lists none', () => {
    const t = pinnedTrust(statement(id, NONCE, [listed(pki)[1]!]), chain, '127.0.0.1');
    expect(t.caSha256).toBeNull();
    expect(t.caPem).toBeNull();
  });
});

describe('helpers', () => {
  it('fingerprints a raw key as base64url SHA-256', () => {
    expect(fingerprintOf(Buffer.from(id.publicKey, 'base64url'))).toBe(id.fingerprint);
    expect(id.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reads certificates out of PEM text and skips damaged blocks', () => {
    const certs = certificatesFromPem([
      `${pki.leafPem}${pki.caPem}`,
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      'nothing',
    ]);
    expect(certs.map(certificateSha256)).toEqual([sha256(pki.leafPem), sha256(pki.caPem)]);
    expect(new X509Certificate(pki.leafPem).checkIP('127.0.0.1')).toBe('127.0.0.1');
  });
});
