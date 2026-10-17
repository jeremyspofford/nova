// M6.5 trust (FR-134, docs/22 §5): the Hub's identity key, the Hub local CA, mesh certificates
// and native-shell pinning. Views and request schemas for /api/v1/trust.
import { z } from 'zod';

/**
 * How clients reach the Hub over HTTPS. `none` serves plain HTTP (unless NOVA_TLS_CERT is set);
 * `local-ca` serves a leaf of the Hub local CA (and, with `trust.meshCerts`, the mesh
 * certificate to clients that name the mesh host); `mesh` serves only the mesh certificate. A
 * switch between plain HTTP and HTTPS applies at the Hub's next start.
 */
export const TRUST_MODES = ['none', 'local-ca', 'mesh'] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

export const trustPatchSchema = z
  .object({
    mode: z.enum(TRUST_MODES).optional(),
    meshCerts: z.boolean().optional(),
    pinNativeShells: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type TrustPatch = z.infer<typeof trustPatchSchema>;

/**
 * `all` renews the leaf and the mesh certificates. `ca` replaces the local CA itself (the owner's
 * explicit choice: every device must install the new root, and device certificates of the old
 * CA stop verifying); the Hub never replaces it on its own.
 */
export const trustRenewSchema = z
  .object({ target: z.enum(['leaf', 'mesh', 'all', 'ca']).default('all') })
  .strict();
export type TrustRenewRequest = z.infer<typeof trustRenewSchema>;

export type TrustCertificateKind = 'hub_tls' | 'device' | 'mesh';

export interface TrustCertificateView {
  id: string;
  kind: TrustCertificateKind;
  /** Lower-case hex. */
  serial: string;
  subject: string;
  deviceId: string | null;
  role: string | null;
  sans: string[];
  notBefore: string;
  notAfter: string;
  createdAt: string;
  /** A Hub certificate a renewal replaced. */
  supersededAt: string | null;
  revokedAt: string | null;
}

export interface TrustCaView {
  /** SHA-256 of the certificate's DER, upper-case hex with colons. */
  fingerprint: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  /** What the CA may sign (RFC 5280 name constraints); a name outside them is never certified. */
  nameConstraints: { dns: string[]; ip: string[] };
}

export interface TrustLeafView {
  serial: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  /** When it is renewed: at two thirds of its life. */
  renewAt: string;
}

export interface TrustMeshCertView {
  host: string;
  notAfter: string;
  status: 'ok' | 'expiring' | 'expired';
}

/** What the running listener serves: an explicit NOVA_TLS_CERT wins over the trust mode. */
export interface TrustServingView {
  scheme: 'http' | 'https';
  source: 'explicit' | 'trust' | 'none';
  /**
   * Set when the trust certificates could not be read at start: the listener then serves plain
   * HTTP on loopback only, never on every interface.
   */
  fallbackReason?: string | null;
}

export interface TrustView {
  mode: TrustMode;
  meshCerts: boolean;
  pinNativeShells: boolean;
  /**
   * The pin native shells keep: base64url(SHA-256(raw Ed25519 public key)). Null when the
   * identity key cannot be loaded (`problems` says why).
   */
  hubFingerprint: string | null;
  hubPublicKey: string | null;
  /** Null until the listener reported (tests, headless use). */
  serving: TrustServingView | null;
  /** The mode differs from what the listener serves: it applies at the next start. */
  restartRequired: boolean;
  ca: TrustCaView | null;
  leaf: TrustLeafView | null;
  meshCert: TrustMeshCertView | null;
  /** Hub TLS, device and mesh certificates, newest first (at most 200). */
  issued: TrustCertificateView[];
  problems: string[];
}

/** What Network diagnostics show about trust (FR-139). */
export interface TrustSummary {
  mode: TrustMode;
  caFingerprint: string | null;
  leafNotAfter: string | null;
  leafSans: string[];
  meshCert: { host: string; notAfter: string } | null;
  problems: string[];
}

/** The client's nonce for `GET /api/v1/trust/identity?nonce=`: 16-64 base64url characters. */
export const identityNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, '16-64 base64url characters');

export const identityQuerySchema = z.object({ nonce: identityNonceSchema }).strict();

/**
 * The Hub's signed statement of the certificates it serves (GET /api/v1/trust/identity). A native
 * shell that pinned `hubFingerprint` checks the key hashes to its pin, the signature, that the
 * nonce is the one it just sent (so an old statement cannot be replayed), and that the TLS
 * certificate it was shown is listed, or is a server certificate for the host it dialed issued by
 * the listed CA (docs/22 §5).
 */
export interface HubIdentityStatement {
  v: 1;
  /** The client's nonce, echoed under the signature. */
  nonce: string;
  hubFingerprint: string;
  hubPublicKey: string;
  /** `required` unless the owner turned pinning off (`trust.pinNativeShells`). */
  pinning: 'required' | 'off';
  certificates: { kind: 'ca' | 'leaf' | 'mesh'; sha256: string; notAfter: string }[];
  issuedAt: string;
  /** base64url Ed25519 signature over `hubIdentityStatementBytes` of the other fields. */
  signature: string;
}

/** The exact bytes the statement's signature covers: a context line, then canonical JSON. */
export function hubIdentityStatementBytes(s: Omit<HubIdentityStatement, 'signature'>): string {
  const body = {
    v: s.v,
    nonce: s.nonce,
    hubFingerprint: s.hubFingerprint,
    hubPublicKey: s.hubPublicKey,
    pinning: s.pinning,
    certificates: s.certificates.map((c) => ({
      kind: c.kind,
      sha256: c.sha256,
      notAfter: c.notAfter,
    })),
    issuedAt: s.issuedAt,
  };
  return `nova-hub-identity-v1\n${JSON.stringify(body)}`;
}
