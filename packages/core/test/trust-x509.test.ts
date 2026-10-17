// The hand-written X.509 builder shared by the egress CA and the Hub local CA (FR-134): Ed25519
// subject keys, name constraints a real TLS client enforces, and the helpers around them.
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { connect, createServer } from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  buildCertificate,
  certificateFingerprint,
  ipBytes,
  nameConstraintsPermit,
  pemToDer,
} from '../src/trust/x509.ts';

const DAY = 86_400_000;

function makeCa(nameConstraints?: { dns: string[]; ip: string[] }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = { commonName: 'Test CA' };
  const cert = buildCertificate({
    subject,
    issuer: subject,
    publicKey,
    signer: privateKey,
    notBefore: new Date(Date.now() - 3_600_000),
    notAfter: new Date(Date.now() + 30 * DAY),
    ca: { pathLength: 0 },
    keyUsage: 0x86,
    ...(nameConstraints ? { nameConstraints } : {}),
  });
  return { cert, key: privateKey, publicKey };
}

function makeLeaf(ca: ReturnType<typeof makeCa>, hosts: string[]) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = buildCertificate({
    subject: { commonName: hosts[0] ?? 'leaf' },
    issuer: { commonName: 'Test CA' },
    publicKey,
    signer: ca.key,
    notBefore: new Date(Date.now() - 3_600_000),
    notAfter: new Date(Date.now() + 10 * DAY),
    keyUsage: 0x80,
    extKeyUsage: ['1.3.6.1.5.5.7.3.1'],
    altNames: { hosts },
  });
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** A TLS handshake on loopback; resolves 'ok' or the client's error message. */
async function handshake(
  cert: string,
  key: string,
  ca: string,
  servername: string,
): Promise<string> {
  const server = createServer({ cert, key }, (s) => s.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  try {
    return await new Promise<string>((resolve) => {
      const c = connect({ host: '127.0.0.1', port, servername, ca }, () => {
        c.on('data', (b: Buffer) => resolve(String(b)));
      });
      c.on('error', (err) => resolve(err.message));
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('X.509 builder', () => {
  it('certifies an Ed25519 key with a P-256 CA', () => {
    const ca = makeCa();
    const device = generateKeyPairSync('ed25519');
    const built = buildCertificate({
      subject: { commonName: 'device-1', organizationalUnit: 'client' },
      issuer: { commonName: 'Test CA' },
      publicKey: device.publicKey,
      signer: ca.key,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + DAY),
      keyUsage: 0x80,
      extKeyUsage: ['1.3.6.1.5.5.7.3.2'],
      altNames: { uris: ['urn:nova:device:device-1'] },
    });
    const x = new X509Certificate(built.pem);
    expect(x.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(x.subject).toContain('OU=client');
    expect(x.subjectAltName).toBe('URI:urn:nova:device:device-1');
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    const caX = new X509Certificate(ca.cert.pem);
    expect(x.checkIssued(caX)).toBe(true);
    expect(x.verify(caX.publicKey)).toBe(true);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(x.verify(other.publicKey)).toBe(false);
    expect(x.serialNumber.toLowerCase()).toBe(built.serial);
    expect(pemToDer(built.pem).equals(built.der)).toBe(true);
  });

  it('formats fingerprints like a browser shows them', () => {
    const ca = makeCa();
    const fp = certificateFingerprint(ca.cert.pem);
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fp).toBe(new X509Certificate(ca.cert.pem).fingerprint256);
  });

  it('matches names against constraints like RFC 5280 does', () => {
    const nc = { dns: ['local', 'home.arpa'], ip: ['192.168.0.0/16', 'fc00::/7', '::1/128'] };
    expect(nameConstraintsPermit(nc, 'local')).toBe(true);
    expect(nameConstraintsPermit(nc, 'hub.local')).toBe(true);
    expect(nameConstraintsPermit(nc, 'HUB.LOCAL.')).toBe(true);
    expect(nameConstraintsPermit(nc, 'hublocal')).toBe(false);
    expect(nameConstraintsPermit(nc, 'local.example.com')).toBe(false);
    expect(nameConstraintsPermit(nc, 'x.home.arpa')).toBe(true);
    expect(nameConstraintsPermit(nc, '192.168.4.2')).toBe(true);
    expect(nameConstraintsPermit(nc, '192.169.0.1')).toBe(false);
    expect(nameConstraintsPermit(nc, 'fd7a:115c:a1e0::1')).toBe(true);
    expect(nameConstraintsPermit(nc, '2001:db8::1')).toBe(false);
    expect(nameConstraintsPermit(nc, '::1')).toBe(true);
    expect(nameConstraintsPermit(nc, '10.0.0.1')).toBe(false);
  });

  it('writes name constraints that a TLS client enforces', async () => {
    const ca = makeCa({ dns: ['local', 'localhost'], ip: ['127.0.0.0/8'] });
    const inside = makeLeaf(ca, ['hub.local', '127.0.0.1']);
    expect(await handshake(inside.cert.pem, inside.key, ca.cert.pem, 'hub.local')).toBe('ok');
    // The CA signs a certificate for a name outside its constraints: the client refuses it even
    // though it trusts the CA.
    const outside = makeLeaf(ca, ['bank.example.com']);
    const refused = await handshake(outside.cert.pem, outside.key, ca.cert.pem, 'bank.example.com');
    expect(refused).not.toBe('ok');
    expect(refused.toLowerCase()).toContain('subtree');
  });

  it('encodes IPv4-mapped and embedded IPv4 addresses as their 16 bytes', () => {
    expect(ipBytes('::ffff:192.168.1.2').toString('hex')).toBe('00000000000000000000ffffc0a80102');
    expect(ipBytes('::ffff:192.168.1.2')).toEqual(ipBytes('::ffff:c0a8:102'));
    expect(ipBytes('64:ff9b::1.2.3.4').toString('hex')).toBe('0064ff9b000000000000000001020304');
    expect(ipBytes('10.0.0.1').toString('hex')).toBe('0a000001');
    expect(ipBytes('fe80::1').toString('hex')).toBe('fe800000000000000000000000000001');
    const ca = makeCa();
    const leaf = makeLeaf(ca, ['::ffff:192.168.1.2']);
    expect(new X509Certificate(leaf.cert.pem).subjectAltName).toBe(
      'IP Address:0:0:0:0:0:FFFF:C0A8:102',
    );
    expect(nameConstraintsPermit({ dns: [], ip: ['::ffff:0:0/96'] }, '::ffff:10.1.2.3')).toBe(true);
  });

  it('refuses a malformed address range', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spec = {
      subject: { commonName: 'x' },
      issuer: { commonName: 'x' },
      publicKey,
      signer: privateKey,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + DAY),
      ca: { pathLength: 0 },
      keyUsage: 0x86,
    };
    expect(() =>
      buildCertificate({ ...spec, nameConstraints: { dns: [], ip: ['nope/8'] } }),
    ).toThrow('not an address range');
    expect(() =>
      buildCertificate({ ...spec, nameConstraints: { dns: [], ip: ['10.0.0.0/33'] } }),
    ).toThrow('bad prefix length');
  });
});
