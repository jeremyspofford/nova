// The Hub -> novad management channel over mutual TLS (ADR-096 D1; FR-126, R-022). A device that
// holds a certificate of the Hub local CA serves its management endpoint over HTTPS and asks for
// the Hub's client certificate (URI SAN `urn:nova:hub:<fingerprint>`, EKU clientAuth). The Hub
// connects with TLS 1.3 only, presents that certificate, and accepts the device only when its
// certificate chains to the Hub CA (OpenSSL checks issuer, signature, validity and purpose) and
// then, in `checkServerIdentity`, names exactly this device (`urn:nova:device:<id>`), carries the
// key the Hub pinned for it, and is a certificate the trust area recorded and did not revoke. The
// host name is never checked: LAN addresses move. The bearer management token is still sent
// (defense in depth), but only on a connection that passed all of that: the request is written
// after the handshake and the checks. No session is reused, so every connection runs the checks.
// A pre-M7.5 device certificate (clientAuth only) is accepted until it is renewed: see
// `openMutualTls`.
import { X509Certificate, type KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { NovaError, type DeviceCertificateStateView, type DeviceTlsFailure } from '@nova/shared';
import { rawEd25519 } from '../trust/identity.ts';
import type { DeviceCertificateCheck } from '../trust/service.ts';
import type { DeviceTransport, DeviceTransportResponse } from './client.ts';

/** What the Hub presents and trusts on the channel (the trust area's client certificate). */
export interface DeviceTlsMaterial {
  certPem: string;
  keyPem: string;
  /** The Hub local CA: the only root a device certificate may chain to. */
  caPem: string;
  /** For diagnostics (the trust area's `HubClientCertificate` carries them). */
  serial?: string;
  notAfter?: string;
  uri?: string;
}

export interface DeviceTlsTrust {
  /** The Hub's client certificate and CA; null while the Hub has no local CA. */
  material(): Promise<DeviceTlsMaterial | null>;
  /** The trust area's check (recorded serial, revocation); without it only the chain counts. */
  verifyDeviceCertificate?(pem: string): DeviceCertificateCheck;
  /**
   * Whether a device certificate without serverAuth (issued before M7.5) may still serve the
   * channel: the device's own recorded one, until it is renewed (`TrustService
   * .legacyServerCertificateAllowed`). Without it such a certificate is refused.
   */
  allowLegacyServerCertificate?(deviceId: string, pem: string): boolean;
  /** The device presented this certificate (renewal bookkeeping: older ones are revoked). */
  presented?(deviceId: string, serial: string): void | Promise<unknown>;
  /** The device's certificate and renewal state, for the channel view (diagnostics, the web). */
  certificateState?(deviceId: string): DeviceCertificateStateView;
}

/** The device a call is meant for: its id and the Ed25519 key the Hub pinned at registration. */
export interface DeviceTarget {
  deviceId: string;
  /** base64url of the raw 32-byte key. */
  publicKey: string;
}

const MESSAGES: Record<DeviceTlsFailure, string> = {
  no_ca: 'the Hub has no local CA to check the device against',
  no_client_certificate: 'the Hub has no client certificate for the management channel',
  untrusted_certificate: 'the device certificate does not chain to the Hub local CA',
  expired: 'the device certificate expired',
  not_yet_valid: 'the device certificate is not valid yet',
  wrong_device: 'the device certificate names another device',
  key_mismatch: 'the device certificate carries another key than the one the Hub pinned',
  revoked: 'the device certificate was revoked',
  unknown_certificate: 'the Hub did not issue this device certificate',
  unsupported_purpose: 'the device certificate cannot be used by a server; add the device again',
  handshake_failed: 'the TLS handshake with the device failed',
};

/** `policy_denied` `{reason: device_tls_failed, tls}`: what a refused channel answers. */
export function deviceTlsError(failure: DeviceTlsFailure, cause?: unknown): NovaError {
  return new NovaError('policy_denied', `management channel refused: ${MESSAGES[failure]}`, {
    details: { reason: 'device_tls_failed', tls: failure },
    action:
      failure === 'handshake_failed' || failure === 'no_client_certificate' || failure === 'no_ca'
        ? 'Check the Hub trust settings and the device, then try again'
        : 'Add the device again with the Hub local CA as the trust path',
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Thrown inside `checkServerIdentity`: carries the failure through the TLS stack. */
class PeerRefused extends Error {
  readonly failure: DeviceTlsFailure;
  constructor(failure: DeviceTlsFailure) {
    super(MESSAGES[failure]);
    this.failure = failure;
  }
}

function keyOf(publicKey: KeyObject): string | null {
  try {
    return rawEd25519(publicKey).toString('base64url');
  } catch {
    return null;
  }
}

/**
 * Check the certificate a device's management server presented, after the chain verified: the
 * URI SAN names this device, the key is the pinned one, and the trust area knows the certificate.
 * Null when it is this device's.
 */
export function checkDeviceServerCertificate(
  der: Buffer,
  target: DeviceTarget,
  verify?: (pem: string) => DeviceCertificateCheck,
): DeviceTlsFailure | null {
  let x: X509Certificate;
  try {
    x = new X509Certificate(der);
  } catch {
    return 'untrusted_certificate';
  }
  const uris = (x.subjectAltName ?? '')
    .split(', ')
    .filter((s) => s.startsWith('URI:'))
    .map((s) => s.slice(4));
  if (uris.length !== 1 || uris[0] !== `urn:nova:device:${target.deviceId}`) return 'wrong_device';
  if (keyOf(x.publicKey) !== target.publicKey) return 'key_mismatch';
  if (verify) {
    const r = verify(x.toString());
    if (!r.ok) {
      switch (r.reason) {
        case 'revoked':
          return 'revoked';
        case 'expired':
          return 'expired';
        case 'not_yet_valid':
          return 'not_yet_valid';
        case 'unknown_serial':
          return 'unknown_certificate';
        case 'no_ca':
          return 'no_ca';
        default:
          return 'untrusted_certificate';
      }
    }
    if (r.deviceId !== target.deviceId) return 'wrong_device';
  }
  return null;
}

/** The OpenSSL verification codes and TLS alerts, as channel failures. */
export function tlsFailureOf(err: unknown): DeviceTlsFailure | null {
  if (err instanceof PeerRefused) return err.failure;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return 'expired';
    case 'CERT_NOT_YET_VALID':
      return 'not_yet_valid';
    case 'INVALID_PURPOSE':
      return 'unsupported_purpose';
    case 'CERT_REVOKED':
      return 'revoked';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'CERT_SIGNATURE_FAILURE':
    case 'CERT_UNTRUSTED':
    case 'CERT_REJECTED':
    case 'PERMITTED_VIOLATION':
    case 'EXCLUDED_VIOLATION':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'untrusted_certificate';
    case 'EPROTO':
      // Not TLS at all (a plain-HTTP server at an https address), or a broken handshake.
      return 'handshake_failed';
    default:
      // A TLS alert (the device refused the Hub's certificate) or a protocol error.
      return code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_') ? 'handshake_failed' : null;
  }
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function materialOf(trust: DeviceTlsTrust): Promise<DeviceTlsMaterial> {
  let material: DeviceTlsMaterial | null;
  try {
    material = await trust.material();
  } catch (err) {
    throw deviceTlsError('no_client_certificate', err);
  }
  if (!material) throw deviceTlsError('no_ca');
  return material;
}

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** One TLS 1.3 connection with the Hub's client certificate; resolves after `secureConnect`. */
function tlsConnect(
  material: DeviceTlsMaterial,
  url: URL,
  timeoutMs: number,
  verify: { strict: true; check: (cert: PeerCertificate) => Error | undefined } | { strict: false },
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 443),
      ALPNProtocols: ['http/1.1'],
      ca: material.caPem,
      cert: material.certPem,
      key: material.keyPem,
      minVersion: 'TLSv1.3',
      // The strict path lets OpenSSL check the chain, validity and purpose, then names the device
      // in `checkServerIdentity`; the legacy path checks everything itself before resolving.
      rejectUnauthorized: verify.strict,
      ...(verify.strict
        ? { checkServerIdentity: (_h: string, c: PeerCertificate) => verify.check(c) }
        : {}),
    });
    const timer = setTimeout(() => {
      socket.destroy(new Error('the device did not answer in time'));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err: Error) => {
      clearTimeout(timer);
      const failure = tlsFailureOf(err);
      reject(failure ? deviceTlsError(failure, err) : err);
    });
  });
}

/**
 * A mutual TLS connection to a device's management endpoint that passed every D1 check; nothing
 * has been written on it yet (the browser area relays DevTools over it, D7; `mutualTlsPost`
 * sends its request on it).
 *
 * Device certificates issued before M7.5 carry clientAuth only, which OpenSSL refuses for a
 * server. Such a certificate is accepted only when the trust area says it is still the device's
 * unrenewed one (`allowLegacyServerCertificate`), on a second connection where the Hub verifies
 * it itself before anything is sent: TLS 1.3, the exact certificate the trust area recorded for
 * this device (issuer, signature, validity, serial, the same bytes, not revoked), the device's URI
 * SAN and pinned key. TLS still proves the device holds that key. Once the renewal is issued and
 * its grace has passed, or the device presented the new certificate (which revokes the old one),
 * the old certificate is refused like any other.
 */
export async function openMutualTls(
  trust: DeviceTlsTrust,
  url: URL,
  target: DeviceTarget,
  timeoutMs: number,
): Promise<TLSSocket> {
  if (url.protocol !== 'https:') throw new TypeError('the mutual TLS channel needs an https URL');
  const material = await materialOf(trust);
  const verify = trust.verifyDeviceCertificate?.bind(trust);
  let serial: string | null = null;
  try {
    const socket = await tlsConnect(material, url, timeoutMs, {
      strict: true,
      check: (cert) => {
        const failure = checkDeviceServerCertificate(cert.raw, target, verify);
        if (failure) return new PeerRefused(failure);
        serial = cert.serialNumber.toLowerCase();
        return undefined;
      },
    });
    // The device shows a newer certificate: its older ones are done (renewal).
    if (serial && trust.presented) {
      try {
        await trust.presented(target.deviceId, serial);
      } catch {
        // bookkeeping only: the connection stands
      }
    }
    return socket;
  } catch (err) {
    const legacy =
      err instanceof NovaError &&
      err.details?.tls === 'unsupported_purpose' &&
      verify !== undefined &&
      trust.allowLegacyServerCertificate !== undefined;
    if (!legacy) throw err;
  }
  const socket = await tlsConnect(material, url, timeoutMs, { strict: false });
  const refuse = (failure: DeviceTlsFailure): never => {
    socket.destroy();
    throw deviceTlsError(failure);
  };
  if (socket.getProtocol() !== 'TLSv1.3') refuse('handshake_failed');
  const peer = socket.getPeerX509Certificate();
  if (!peer) return refuse('untrusted_certificate');
  const failure = checkDeviceServerCertificate(peer.raw, target, verify);
  if (failure) return refuse(failure);
  if ((peer.keyUsage ?? []).includes(SERVER_AUTH)) refuse('untrusted_certificate');
  if (!trust.allowLegacyServerCertificate!(target.deviceId, peer.toString()))
    refuse('unsupported_purpose');
  return socket;
}

/**
 * One POST over mutual TLS, sent only on a connection `openMutualTls` verified. TLS failures are
 * `policy_denied` `{reason: device_tls_failed, tls}` (never retried over plain HTTP); a device
 * that cannot be reached throws a plain error, which `callDevice` turns into `node_unavailable`.
 */
export async function mutualTlsPost(
  trust: DeviceTlsTrust,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  target: DeviceTarget,
): Promise<DeviceTransportResponse> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new TypeError('the mutual TLS channel needs an https URL');
  const socket = await openMutualTls(trust, u, target, timeoutMs);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<DeviceTransportResponse>((resolve, reject) => {
    let settled = false;
    let answered = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      let failure = tlsFailureOf(err);
      // TLS 1.3: the device checks the Hub's certificate after the client's last flight, so a
      // device that refuses it closes the connection right after the handshake, before any
      // answer. Read as a refused handshake, not as a device that went away.
      const code = (err as { code?: unknown } | null)?.code;
      if (!failure && !answered && (code === 'ECONNRESET' || code === 'EPIPE'))
        failure = 'handshake_failed';
      reject(
        failure
          ? deviceTlsError(failure, err)
          : err instanceof Error
            ? err
            : new Error(String(err)),
      );
    };
    const req = httpRequest(
      {
        host: u.hostname,
        port: Number(u.port || 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          host: u.host,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
        // The verified connection, never a new one.
        createConnection: () => socket,
        timeout: timeoutMs,
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          socket.end();
          resolve({
            status: res.statusCode ?? 0,
            body: parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the device did not answer in time')));
    req.on('error', fail);
    req.end(payload);
  });
}

/** A `DeviceTransport` for https endpoints (the DeviceService uses it per call). */
export function mutualTlsDeviceTransport(trust: DeviceTlsTrust): DeviceTransport {
  return {
    post(url, token, body, timeoutMs, target) {
      if (!target) return Promise.reject(new TypeError('a mutual TLS call needs its device'));
      return mutualTlsPost(trust, url, token, body, timeoutMs, target);
    },
  };
}
