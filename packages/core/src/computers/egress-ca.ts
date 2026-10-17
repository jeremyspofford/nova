// The per-Hub CA the egress proxy inspects HTTPS with (docs/12 §5 and §8, ADR-063). The proxy
// terminates TLS for `limited` mode, for hosts that receive injected credentials and for hosts
// with stripping hooks; sandboxes trust only the CA's public certificate. The key stays in the
// Hub's data folder (a protected path no sandbox or tool can read) and is never exported.
//
// The certificates (a self-signed CA and short-lived leaf certificates, ECDSA P-256 with SHA-256)
// come from the hand-written DER builder in ../trust/x509.ts, which the Hub local CA (FR-134) also
// uses. This CA stays separate from that one, with its own key: it never signs Hub TLS or device
// certificates.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, rootCertificates, type SecureContext } from 'node:tls';
import { buildCertificate as buildX509, KEY_USAGE, keyId, OID } from '../trust/x509.ts';

interface CertInput {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signer: KeyObject;
  issuerKeyId: Buffer;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  hosts?: string[];
}

function buildCertificate(c: CertInput): string {
  return buildX509({
    subject: { commonName: c.subject },
    issuer: { commonName: c.issuer },
    publicKey: c.publicKey,
    signer: c.signer,
    notBefore: c.notBefore,
    notAfter: c.notAfter,
    ...(c.ca
      ? {
          ca: { pathLength: 0 },
          // digitalSignature, keyCertSign, cRLSign.
          keyUsage: KEY_USAGE.digitalSignature | KEY_USAGE.keyCertSign | KEY_USAGE.cRLSign,
        }
      : {
          issuerKeyId: c.issuerKeyId,
          keyUsage: KEY_USAGE.digitalSignature,
          extKeyUsage: [OID.serverAuth],
          altNames: { hosts: c.hosts ?? [] },
        }),
  }).pem;
}

// ---- the CA -----------------------------------------------------------------------------------

const CA_NAME = 'Nova egress inspection CA';
const LEAF_DAYS = 30;
const MAX_LEAVES = 500;

export interface CertificateAuthorityOptions {
  now?: () => Date;
}

export class CertificateAuthority {
  readonly certPem: string;
  readonly #key: KeyObject;
  readonly #keyId: Buffer;
  readonly #now: () => Date;
  readonly #leaves = new Map<string, { ctx: SecureContext; certPem: string; expires: number }>();

  constructor(certPem: string, keyPem: string, opts: CertificateAuthorityOptions = {}) {
    this.certPem = certPem;
    this.#key = createPrivateKey(keyPem);
    this.#keyId = keyId(createPublicKey(this.#key));
    this.#now = opts.now ?? (() => new Date());
  }

  /** A new CA with a fresh P-256 key, valid for ten years. */
  static create(opts: CertificateAuthorityOptions = {}): { certPem: string; keyPem: string } {
    const now = (opts.now ?? (() => new Date()))();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const certPem = buildCertificate({
      subject: CA_NAME,
      issuer: CA_NAME,
      publicKey,
      signer: privateKey,
      issuerKeyId: keyId(publicKey),
      notBefore: new Date(now.getTime() - 3_600_000),
      notAfter: new Date(now.getTime() + 10 * 365 * 86_400_000),
      ca: true,
    });
    return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  }

  /**
   * The Hub's CA from `<dir>/ca-cert.pem` and `<dir>/ca-key.pem` (key mode 0600), created on
   * first use or when the stored one is unreadable or expires within 30 days.
   */
  static loadOrCreate(dir: string, opts: CertificateAuthorityOptions = {}): CertificateAuthority {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const certPath = join(dir, 'ca-cert.pem');
    const keyPath = join(dir, 'ca-key.pem');
    const now = (opts.now ?? (() => new Date()))();
    if (existsSync(certPath) && existsSync(keyPath)) {
      try {
        const certPem = readFileSync(certPath, 'utf8');
        const x = new X509Certificate(certPem);
        if (new Date(x.validTo).getTime() - now.getTime() > 30 * 86_400_000)
          return new CertificateAuthority(certPem, readFileSync(keyPath, 'utf8'), opts);
      } catch {
        // Unreadable: replace it below.
      }
    }
    const fresh = CertificateAuthority.create(opts);
    writeFileSync(keyPath, fresh.keyPem, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(certPath, fresh.certPem, { mode: 0o644 });
    return new CertificateAuthority(fresh.certPem, fresh.keyPem, opts);
  }

  /** The system roots plus this CA: what a sandbox trusts, since not every host is inspected. */
  bundlePem(): string {
    return `${rootCertificates.join('\n')}\n${this.certPem}`;
  }

  /** A leaf certificate for one host (DNS name or IP), cached until it nears expiry. */
  leaf(host: string): { certPem: string; context: SecureContext } {
    const now = this.#now().getTime();
    const hit = this.#leaves.get(host);
    if (hit && hit.expires - now > 86_400_000) return { certPem: hit.certPem, context: hit.ctx };
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const expires = now + LEAF_DAYS * 86_400_000;
    const certPem = buildCertificate({
      subject: host.slice(0, 64),
      issuer: CA_NAME,
      publicKey,
      signer: this.#key,
      issuerKeyId: this.#keyId,
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(expires),
      ca: false,
      hosts: [host],
    });
    const ctx = createSecureContext({
      cert: certPem,
      key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    this.#leaves.delete(host);
    this.#leaves.set(host, { ctx, certPem, expires });
    while (this.#leaves.size > MAX_LEAVES) {
      const oldest = this.#leaves.keys().next().value;
      if (oldest === undefined) break;
      this.#leaves.delete(oldest);
    }
    return { certPem, context: ctx };
  }
}
