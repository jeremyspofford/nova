// The per-Hub CA the egress proxy inspects HTTPS with (docs/12 §5 and §8, ADR-063). The proxy
// terminates TLS for `limited` mode, for hosts that receive injected credentials and for hosts
// with stripping hooks; sandboxes trust only the CA's public certificate. The key stays in the
// Hub's data folder (a protected path no sandbox or tool can read) and is never exported.
//
// Node has no API to create certificates, so this file builds the few X.509 v3 structures the
// proxy needs (a self-signed CA and short-lived leaf certificates) in DER by hand: ECDSA P-256
// with SHA-256, with the extensions strict TLS clients check (basic constraints, key usage,
// extended key usage, subject alternative names, key identifiers).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, rootCertificates, type SecureContext } from 'node:tls';

// ---- DER --------------------------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), derLength(b.length), b]);
}

const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octets = (b: Buffer) => tlv(0x04, b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, b: Buffer) => tlv(0xa0 | n, b);

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const stack = [p % 128];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
      stack.unshift(0x80 | (v % 128));
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function uint(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, (v[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

/** A BIT STRING of named bits, minimally encoded (DER drops trailing zero bits). */
function namedBits(byte: number): Buffer {
  let unused = 0;
  while (unused < 7 && !((byte >> unused) & 1)) unused++;
  return tlv(0x03, Buffer.from([unused, byte]));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${iso}Z`));
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function name(cn: string): Buffer {
  return seq(
    set(seq(oid(OID.organization), utf8('Nova'))),
    set(seq(oid(OID.commonName), utf8(cn))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest();
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  // Expand an IPv6 literal to 16 bytes.
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

function toPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

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
  const algorithm = seq(oid(OID.ecdsaSha256));
  const exts: Buffer[] = [
    extension(OID.basicConstraints, true, c.ca ? seq(bool(true), uint(Buffer.from([0]))) : seq()),
    // CA: digitalSignature, keyCertSign, cRLSign; leaf: digitalSignature.
    extension(OID.keyUsage, true, namedBits(c.ca ? 0x86 : 0x80)),
    extension(OID.subjectKeyId, false, octets(keyId(c.publicKey))),
  ];
  if (!c.ca) {
    exts.push(extension(OID.authorityKeyId, false, seq(tlv(0x80, c.issuerKeyId))));
    exts.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
    const names = (c.hosts ?? []).map((h) =>
      isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii')),
    );
    exts.push(extension(OID.subjectAltName, false, seq(...names)));
  }
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const tbs = seq(
    explicit(0, uint(Buffer.from([2]))),
    uint(serial),
    algorithm,
    name(c.issuer),
    seq(time(c.notBefore), time(c.notAfter)),
    name(c.subject),
    c.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...exts)),
  );
  const signature = sign('sha256', tbs, c.signer);
  return toPem(seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature)));
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
