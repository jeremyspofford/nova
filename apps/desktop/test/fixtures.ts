// Test PKI and Hub identity: a CA, a server leaf for the hosts a test dials, a device certificate
// (client-only), and identity statements signed like the Hub signs them (docs/22 §5). The
// certificates come from the Hub's own X.509 builder, so the shell is checked against exactly
// what a Hub serves.
import {
  createHash,
  generateKeyPairSync,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { hubIdentityStatementBytes, type HubIdentityStatement } from '@nova/shared';
import { buildCertificate, keyId, KEY_USAGE, OID } from '../../../packages/core/src/trust/x509.ts';

const DAY = 86_400_000;

export interface Pki {
  caPem: string;
  leafPem: string;
  leafKeyPem: string;
  devicePem: string;
  /** A leaf for the same hosts from an unrelated CA. */
  strangerPem: string;
  strangerKeyPem: string;
  ca: X509Certificate;
  leaf: X509Certificate;
  device: X509Certificate;
  stranger: X509Certificate;
}

function ec(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function makeCa(name: string, now: Date) {
  const key = ec();
  const dn = { commonName: name };
  const cert = buildCertificate({
    subject: dn,
    issuer: dn,
    publicKey: key.publicKey,
    signer: key.privateKey,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + 3650 * DAY),
    ca: { pathLength: 0 },
    keyUsage: KEY_USAGE.digitalSignature | KEY_USAGE.keyCertSign | KEY_USAGE.cRLSign,
  });
  return { key, dn, cert };
}

function makeLeaf(ca: ReturnType<typeof makeCa>, hosts: string[], now: Date, days = 90) {
  const key = ec();
  const cert = buildCertificate({
    subject: { commonName: hosts[0] ?? 'hub' },
    issuer: ca.dn,
    publicKey: key.publicKey,
    signer: ca.key.privateKey,
    issuerKeyId: keyId(ca.key.publicKey),
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + days * DAY),
    keyUsage: KEY_USAGE.digitalSignature,
    extKeyUsage: [OID.serverAuth],
    altNames: { hosts },
  });
  return { cert, keyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function makePki(hosts: string[] = ['127.0.0.1', 'localhost'], now = new Date()): Pki {
  const ca = makeCa('Test Hub CA', now);
  const leaf = makeLeaf(ca, hosts, now);
  const device = buildCertificate({
    subject: { commonName: 'device-1', organizationalUnit: 'client' },
    issuer: ca.dn,
    publicKey: generateKeyPairSync('ed25519').publicKey,
    signer: ca.key.privateKey,
    issuerKeyId: keyId(ca.key.publicKey),
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + 365 * DAY),
    keyUsage: KEY_USAGE.digitalSignature,
    extKeyUsage: [OID.clientAuth],
    altNames: { uris: ['urn:nova:device:device-1'], hosts },
  });
  const other = makeCa('Somebody else', now);
  const stranger = makeLeaf(other, hosts, now);
  return {
    caPem: ca.cert.pem,
    leafPem: leaf.cert.pem,
    leafKeyPem: leaf.keyPem,
    devicePem: device.pem,
    strangerPem: stranger.cert.pem,
    strangerKeyPem: stranger.keyPem,
    ca: new X509Certificate(ca.cert.pem),
    leaf: new X509Certificate(leaf.cert.pem),
    device: new X509Certificate(device.pem),
    stranger: new X509Certificate(stranger.cert.pem),
  };
}

export const sha256 = (pem: string) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');

export interface Identity {
  privateKey: KeyObject;
  publicKey: string;
  fingerprint: string;
}

export function makeIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x ?? '';
  return {
    privateKey,
    publicKey: raw,
    fingerprint: createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url'),
  };
}

/** A statement signed by `id`, as `GET /api/v1/trust/identity` answers. */
export function statement(
  id: Identity,
  nonce: string,
  certificates: HubIdentityStatement['certificates'],
  extra: Partial<Omit<HubIdentityStatement, 'signature'>> = {},
): HubIdentityStatement {
  const unsigned: Omit<HubIdentityStatement, 'signature'> = {
    v: 1,
    nonce,
    hubFingerprint: id.fingerprint,
    hubPublicKey: id.publicKey,
    pinning: 'required',
    certificates,
    issuedAt: new Date().toISOString(),
    ...extra,
  };
  const signature = sign(
    null,
    Buffer.from(hubIdentityStatementBytes(unsigned)),
    id.privateKey,
  ).toString('base64url');
  return { ...unsigned, signature };
}

/** The certificate list a Hub with this PKI publishes: its CA and its current leaf. */
export function listed(pki: Pki): HubIdentityStatement['certificates'] {
  const notAfter = new Date(Date.now() + 90 * DAY).toISOString();
  return [
    { kind: 'ca', sha256: sha256(pki.caPem), notAfter },
    { kind: 'leaf', sha256: sha256(pki.leafPem), notAfter },
  ];
}
