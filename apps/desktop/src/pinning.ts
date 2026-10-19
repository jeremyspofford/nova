// Native-shell pinning (FR-134, docs/22 §5): the shell trusts its Hub only when the Hub's signed
// identity statement, carrying the shell's own fresh nonce, comes from the key pinned at Add Device
// and vouches for the certificate the shell was shown. This mirrors `checkHubIdentity` in
// packages/core/src/trust/pinning.ts (the reference); the shell keeps its own copy so its main
// process does not load the Hub's core. Only node:crypto is used, never hand-rolled primitives.
import { X509Certificate, createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { hubIdentityStatementBytes, type HubIdentityStatement } from '@nova/shared';

/** The extended key usage of a TLS server certificate (RFC 5280 §4.2.1.12). */
export const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

export type RefusalReason =
  | 'pin_mismatch'
  | 'bad_signature'
  | 'nonce_mismatch'
  | 'no_certificate'
  | 'not_listed'
  | 'not_server_certificate'
  | 'host_mismatch'
  | 'expired';

export type IdentityCheck =
  | { result: 'trusted'; via: 'listed' | 'ca' }
  /** The owner turned pinning off (signed): the platform's trust store decides instead. */
  | { result: 'use_platform_roots' }
  | { result: 'refused'; reason: RefusalReason };

export interface IdentityCheckInput {
  statement: HubIdentityStatement;
  /** The fingerprint pinned at Add Device (`fp=` of the link, or typed by the user). */
  pin: string;
  /** The nonce the shell sent with this request. */
  nonce: string;
  /** The host name or address the shell dialed. */
  host: string;
  /** The chain the server presented on the same connection, leaf first; empty for plain HTTP. */
  chain: X509Certificate[];
  now?: Date;
}

/** base64url(SHA-256(raw Ed25519 public key)): the 43-character fingerprint devices pin. */
export function fingerprintOf(rawPublicKey: Uint8Array): string {
  return createHash('sha256').update(rawPublicKey).digest('base64url');
}

/** Lower-case hex SHA-256 of a certificate's DER bytes, as the statement lists them. */
export function certificateSha256(cert: X509Certificate): string {
  return createHash('sha256').update(cert.raw).digest('hex');
}

function ed25519FromRaw(base64url: string): KeyObject {
  const raw = Buffer.from(base64url, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== base64url)
    throw new Error('expected base64url of a raw 32-byte Ed25519 key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url }, format: 'jwk' });
}

const refused = (reason: RefusalReason) => ({ result: 'refused', reason }) as const;

function current(cert: X509Certificate, now: Date): boolean {
  const t = now.getTime();
  return t >= Date.parse(cert.validFrom) && t <= Date.parse(cert.validTo);
}

/**
 * The statement half of the check (docs/22 §5 step 4): the key hashes to the pin, the Hub says
 * the same, the signature covers the statement, and the nonce is the one just sent.
 */
export function checkStatement(
  s: HubIdentityStatement,
  pin: string,
  nonce: string,
): RefusalReason | null {
  let key: KeyObject;
  try {
    key = ed25519FromRaw(s.hubPublicKey);
  } catch {
    return 'pin_mismatch';
  }
  if (s.hubFingerprint !== pin || fingerprintOf(Buffer.from(s.hubPublicKey, 'base64url')) !== pin)
    return 'pin_mismatch';
  const { signature, ...unsigned } = s;
  let ok: boolean;
  try {
    ok = verify(
      null,
      Buffer.from(hubIdentityStatementBytes(unsigned)),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) return 'bad_signature';
  // A statement for another request (an old one replayed) carries another nonce.
  if (s.nonce !== nonce) return 'nonce_mismatch';
  return null;
}

/**
 * Whether `leaf` is a server certificate for `host` issued by `ca` (docs/22 §5 step 6): issuer
 * and signature check, not a CA, serverAuth, a DNS or IP name matching the host dialed (never the
 * subject's common name). Device certificates are client-only and never pass.
 */
export function issuedForHost(
  leaf: X509Certificate,
  ca: X509Certificate,
  host: string,
): RefusalReason | null {
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return 'not_listed';
  if (leaf.ca || !(leaf.keyUsage ?? []).includes(SERVER_AUTH)) return 'not_server_certificate';
  const h = host.replace(/^\[|\]$/g, '');
  const matches = isIP(h) ? leaf.checkIP(h) : leaf.checkHost(h, { subject: 'never' });
  return matches ? null : 'host_mismatch';
}

/** The full check of one connection (docs/22 §5 steps 4-6). */
export function verifyHubIdentity(input: IdentityCheckInput): IdentityCheck {
  const s = input.statement;
  const bad = checkStatement(s, input.pin, input.nonce);
  if (bad) return refused(bad);
  if (s.pinning === 'off') return { result: 'use_platform_roots' };
  const leaf = input.chain[0];
  if (!leaf) return refused('no_certificate');
  const now = input.now ?? new Date();
  const leafHash = certificateSha256(leaf);
  if (s.certificates.some((c) => (c.kind === 'leaf' || c.kind === 'mesh') && c.sha256 === leafHash))
    return current(leaf, now) ? { result: 'trusted', via: 'listed' } : refused('expired');
  const caHash = s.certificates.find((c) => c.kind === 'ca')?.sha256;
  const ca = caHash ? input.chain.find((c) => certificateSha256(c) === caHash) : undefined;
  if (!ca) return refused('not_listed');
  const issued = issuedForHost(leaf, ca, input.host);
  if (issued) return refused(issued);
  return current(leaf, now) ? { result: 'trusted', via: 'ca' } : refused('expired');
}

/**
 * What a verified statement lets the shell accept on later connections (docs/22 §5 step 7): the
 * listed leaf and mesh certificates, and server certificates of the listed CA. Public material
 * only; the CA certificate is kept so a connection whose chain omits it can still be checked.
 */
export interface PinnedTrust {
  kind: 'pinned';
  host: string;
  listed: string[];
  caSha256: string | null;
  caPem: string | null;
}

export function pinnedTrust(
  s: HubIdentityStatement,
  chain: X509Certificate[],
  host: string,
): PinnedTrust {
  const caSha256 = s.certificates.find((c) => c.kind === 'ca')?.sha256 ?? null;
  const ca = caSha256 ? chain.find((c) => certificateSha256(c) === caSha256) : undefined;
  return {
    kind: 'pinned',
    host,
    listed: s.certificates.filter((c) => c.kind !== 'ca').map((c) => c.sha256),
    caSha256,
    caPem: ca ? ca.toString() : null,
  };
}

/**
 * Whether a later connection's chain (leaf first) is one the verified statement vouched for.
 * `unknown` means: run the statement check again with a new nonce before deciding (step 7).
 */
export function certificateDecision(
  chain: X509Certificate[],
  host: string,
  trust: PinnedTrust,
  now: Date = new Date(),
): 'accept' | 'unknown' {
  const leaf = chain[0];
  if (!leaf || host.toLowerCase() !== trust.host.toLowerCase()) return 'unknown';
  if (!current(leaf, now)) return 'unknown';
  if (trust.listed.includes(certificateSha256(leaf))) return 'accept';
  if (!trust.caSha256) return 'unknown';
  const candidates = [...chain.slice(1)];
  if (trust.caPem) {
    try {
      candidates.push(new X509Certificate(trust.caPem));
    } catch {
      // a damaged cache entry: the chain alone decides
    }
  }
  const ca = candidates.find((c) => certificateSha256(c) === trust.caSha256);
  if (!ca) return 'unknown';
  return issuedForHost(leaf, ca, host) === null ? 'accept' : 'unknown';
}

/** Certificates from PEM text (one or more blocks), leaf first; unreadable blocks are skipped. */
export function certificatesFromPem(pems: readonly string[]): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const pem of pems) {
    for (const block of pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []) {
      try {
        out.push(new X509Certificate(block));
      } catch {
        // not a certificate
      }
    }
  }
  return out;
}
