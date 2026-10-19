// The native-shell pinning check (FR-134, docs/22 §5), as a reference for every client that pins
// the Hub identity: a native shell, `novad`, the compute service, the network probe. A client
// that pinned the Hub's fingerprint at Add Device trusts a TLS connection only when the Hub's
// signed statement, carrying the client's own nonce, vouches for the certificate it was shown.
import type { X509Certificate } from 'node:crypto';
import { createHash, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { hubIdentityStatementBytes, type HubIdentityStatement } from '@nova/shared';
import { ed25519FromRaw, hubFingerprint } from './identity.ts';
import { OID } from './x509.ts';

export interface HubIdentityCheckInput {
  /** The answer of `GET /api/v1/trust/identity?nonce=<nonce>` over the connection being checked. */
  statement: HubIdentityStatement;
  /** The fingerprint pinned at Add Device (QR `hubFingerprint`, `--pin`). */
  pin: string;
  /** The nonce this client sent with the request. */
  nonce: string;
  /** The host name or address the client dialed. */
  host: string;
  /** The certificate chain the server presented, leaf first. */
  chain: X509Certificate[];
  now?: Date;
}

export type HubIdentityCheck =
  | { result: 'trusted'; via: 'listed' | 'ca' }
  /** Pinning is off (owner's choice, signed): verify the chain with the platform roots instead. */
  | { result: 'use_platform_roots' }
  | {
      result: 'refused';
      reason:
        | 'pin_mismatch'
        | 'bad_signature'
        | 'nonce_mismatch'
        | 'no_certificate'
        | 'not_listed'
        | 'not_server_certificate'
        | 'host_mismatch'
        | 'expired';
    };

function sha256(x: X509Certificate): string {
  return createHash('sha256').update(x.raw).digest('hex');
}

function refused(reason: Extract<HubIdentityCheck, { result: 'refused' }>['reason']) {
  return { result: 'refused', reason } as const;
}

/**
 * Whether to trust a connection to the Hub. Accepted: a leaf whose SHA-256 the statement lists
 * (the Hub's current leaf or mesh certificate), or a server certificate (serverAuth, a SAN for
 * the dialed host, not a CA) issued by the CA the statement lists. Device certificates, which the
 * same CA issues for client authentication only, never pass.
 */
export function checkHubIdentity(input: HubIdentityCheckInput): HubIdentityCheck {
  const s = input.statement;
  let key;
  try {
    key = ed25519FromRaw(s.hubPublicKey);
  } catch {
    return refused('pin_mismatch');
  }
  if (
    s.hubFingerprint !== input.pin ||
    hubFingerprint(Buffer.from(s.hubPublicKey, 'base64url')) !== input.pin
  )
    return refused('pin_mismatch');
  const { signature, ...unsigned } = s;
  if (
    typeof signature !== 'string' ||
    !verify(
      null,
      Buffer.from(hubIdentityStatementBytes(unsigned)),
      key,
      Buffer.from(signature, 'base64url'),
    )
  )
    return refused('bad_signature');
  // A statement for another request (an old one replayed) carries another nonce.
  if (s.nonce !== input.nonce) return refused('nonce_mismatch');
  if (s.pinning === 'off') return { result: 'use_platform_roots' };
  const leaf = input.chain[0];
  if (!leaf) return refused('no_certificate');
  const now = (input.now ?? new Date()).getTime();
  const current = now >= Date.parse(leaf.validFrom) && now <= Date.parse(leaf.validTo);
  const leafHash = sha256(leaf);
  if (s.certificates.some((c) => (c.kind === 'leaf' || c.kind === 'mesh') && c.sha256 === leafHash))
    return current ? { result: 'trusted', via: 'listed' } : refused('expired');
  const caHash = s.certificates.find((c) => c.kind === 'ca')?.sha256;
  const ca = caHash ? input.chain.find((c) => sha256(c) === caHash) : undefined;
  if (!ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return refused('not_listed');
  // Only a server certificate: never a CA, never a client-only certificate, and never a Nova
  // identity certificate (a device's, which also serves its management endpoint since M7.5, or
  // the Hub's client certificate): those name a device or the Hub, not a host.
  if (
    leaf.ca ||
    !(leaf.keyUsage ?? []).includes(OID.serverAuth) ||
    (leaf.subjectAltName ?? '').split(', ').some((n) => n.startsWith('URI:urn:nova:'))
  )
    return refused('not_server_certificate');
  const host = input.host.replace(/^\[|\]$/g, '');
  const matches = isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' });
  if (!matches) return refused('host_mismatch');
  return current ? { result: 'trusted', via: 'ca' } : refused('expired');
}
