// X.509 v3 certificates in DER, built by hand because Node has no API to create them. Both of the
// Hub's CAs use it: the egress inspection CA (docs/12 §8, ADR-063) and the Hub local CA for HTTPS
// and device certificates (FR-134, docs/22 §5). They stay separate CAs with separate keys.
//
// Signatures are ECDSA P-256 with SHA-256. The subject key may be any key node:crypto exports as
// SubjectPublicKeyInfo: P-256 for TLS certificates, Ed25519 (OID 1.3.101.112) for device
// certificates, whose devices hold Ed25519 keys (docs/22 §4.1). The extensions are the ones strict
// TLS clients check: basic constraints, key usage, extended key usage, subject alternative names,
// key identifiers, and name constraints on a CA (RFC 5280 §4.2.1.10).
import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

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

export const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ed25519: '1.3.101.112',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

/** Key usage bits (RFC 5280 §4.2.1.3), as the first byte of the BIT STRING. */
export const KEY_USAGE = {
  digitalSignature: 0x80,
  keyCertSign: 0x04,
  cRLSign: 0x02,
} as const;

export interface DistinguishedName {
  commonName: string;
  /** Defaults to `Nova`. */
  organization?: string;
  organizationalUnit?: string;
}

function name(n: DistinguishedName): Buffer {
  const rdns = [set(seq(oid(OID.organization), utf8(n.organization ?? 'Nova')))];
  if (n.organizationalUnit)
    rdns.push(set(seq(oid(OID.organizationalUnit), utf8(n.organizationalUnit))));
  rdns.push(set(seq(oid(OID.commonName), utf8(n.commonName))));
  return seq(...rdns);
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

/** The key identifier RFC 5280 §4.2.1.2 method 1 suggests: SHA-1 over the encoded key. */
export function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest();
}

/** An IPv4 or IPv6 literal as its 4 or 16 bytes. */
export function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  // An IPv6 literal may end in a dotted IPv4 address (`::ffff:192.168.1.2`): that is two groups.
  let literal = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted?.[1] && isIP(dotted[1]) === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split('.').map(Number);
    literal = `${ip.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  // Expand an IPv6 literal to 16 bytes.
  const [head = '', tail = ''] = literal.split('::');
  const h = head ? head.split(':') : [];
  const t = literal.includes('::') && tail ? tail.split(':') : [];
  const groups = [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

export function toPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

export function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----[\s\S]*$/, '')
    .replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

/** SHA-256 of a certificate's DER, upper-case hex with colons (how browsers show it). */
export function certificateFingerprint(pem: string): string {
  const hex = createHash('sha256').update(pemToDer(pem)).digest('hex').toUpperCase();
  return hex.replace(/(..)(?!$)/g, '$1:');
}

// ---- name constraints -------------------------------------------------------------------------

export interface NameConstraints {
  /** Permitted DNS subtrees: `local` permits `local` and every name ending in `.local`. */
  dns: string[];
  /** Permitted address ranges in CIDR form (`10.0.0.0/8`, `fc00::/7`). */
  ip: string[];
}

function cidrBytes(cidr: string): Buffer {
  const [addr = '', bitsText] = cidr.split('/');
  const family = isIP(addr);
  if (!family) throw new Error(`not an address range: ${cidr}`);
  const size = family === 4 ? 4 : 16;
  const bits = bitsText === undefined ? size * 8 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > size * 8)
    throw new Error(`bad prefix length: ${cidr}`);
  const mask = Buffer.alloc(size);
  for (let i = 0; i < size; i++) mask[i] = 0xff & ~(0xff >> Math.max(0, Math.min(8, bits - i * 8)));
  const base = ipBytes(addr);
  for (let i = 0; i < size; i++) base[i] = (base[i] ?? 0) & (mask[i] ?? 0);
  return Buffer.concat([base, mask]);
}

/** Whether a name (DNS or IP literal) falls inside the permitted subtrees. */
export function nameConstraintsPermit(nc: NameConstraints, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIP(h)) {
    const bytes = ipBytes(h);
    return nc.ip.some((cidr) => {
      const range = cidrBytes(cidr);
      if (range.length !== bytes.length * 2) return false;
      for (let i = 0; i < bytes.length; i++) {
        const m = range[bytes.length + i] ?? 0;
        if (((bytes[i] ?? 0) & m) !== (range[i] ?? 0)) return false;
      }
      return true;
    });
  }
  return nc.dns.some((d) => {
    const base = d.toLowerCase().replace(/^\./, '');
    return h === base || h.endsWith(`.${base}`);
  });
}

function nameConstraintsValue(nc: NameConstraints): Buffer {
  const subtrees = [
    ...nc.dns.map((d) => seq(tlv(0x82, Buffer.from(d.replace(/^\./, ''), 'ascii')))),
    ...nc.ip.map((c) => seq(tlv(0x87, cidrBytes(c)))),
  ];
  // permittedSubtrees [0] IMPLICIT GeneralSubtrees.
  return seq(tlv(0xa0, ...subtrees));
}

// ---- certificates -----------------------------------------------------------------------------

export interface SubjectAltNames {
  /** DNS names and IP literals; each goes in as a dNSName or an iPAddress. */
  hosts?: string[];
  /** URIs (`urn:nova:device:<id>`). */
  uris?: string[];
}

export interface CertificateSpec {
  subject: DistinguishedName;
  issuer: DistinguishedName;
  /** The certified key: P-256 for TLS, Ed25519 for devices. */
  publicKey: KeyObject;
  /** The issuer's ECDSA P-256 private key. */
  signer: KeyObject;
  /** The issuer's key identifier; omitted for a self-signed CA. */
  issuerKeyId?: Buffer;
  notBefore: Date;
  notAfter: Date;
  /** Positive, at most 20 bytes; random 16 bytes by default. */
  serial?: Buffer;
  /** A CA certificate; `pathLength` 0 allows no intermediate CAs below it. */
  ca?: { pathLength: number };
  keyUsage: number;
  extKeyUsage?: string[];
  altNames?: SubjectAltNames;
  nameConstraints?: NameConstraints;
}

export interface BuiltCertificate {
  pem: string;
  der: Buffer;
  /** Lower-case hex, no separators. */
  serial: string;
}

/** A fresh positive serial number (RFC 5280 §4.1.2.2: positive, at most 20 octets). */
export function randomSerial(): Buffer {
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  return serial;
}

export function buildCertificate(c: CertificateSpec): BuiltCertificate {
  const algorithm = seq(oid(OID.ecdsaSha256));
  const exts: Buffer[] = [
    extension(
      OID.basicConstraints,
      true,
      c.ca ? seq(bool(true), uint(Buffer.from([c.ca.pathLength]))) : seq(),
    ),
    extension(OID.keyUsage, true, namedBits(c.keyUsage)),
    extension(OID.subjectKeyId, false, octets(keyId(c.publicKey))),
  ];
  if (c.issuerKeyId) exts.push(extension(OID.authorityKeyId, false, seq(tlv(0x80, c.issuerKeyId))));
  if (c.extKeyUsage?.length)
    exts.push(extension(OID.extKeyUsage, false, seq(...c.extKeyUsage.map((o) => oid(o)))));
  const names = [
    ...(c.altNames?.hosts ?? []).map((h) =>
      isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii')),
    ),
    ...(c.altNames?.uris ?? []).map((u) => tlv(0x86, Buffer.from(u, 'ascii'))),
  ];
  if (names.length) exts.push(extension(OID.subjectAltName, false, seq(...names)));
  // Critical, as RFC 5280 §4.2.1.10 requires of a CA that sets it.
  if (c.nameConstraints)
    exts.push(extension(OID.nameConstraints, true, nameConstraintsValue(c.nameConstraints)));
  const serial = c.serial ?? randomSerial();
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
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  return { pem: toPem(der), der, serial: serial.toString('hex') };
}
