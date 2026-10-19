// Redfish over HTTPS with the BMC certificate pinned (FR-147, ADR-096 D6). BMCs present
// self-signed certificates, so the chain is never "trusted": the Hub pins the SHA-256 of the
// certificate's DER on first use, like an SSH host key, and from then on a connection is used only
// when the BMC shows that same certificate. The TLS handshake completes and the pin is checked
// before a single byte of HTTP (and so before the credentials) is written. Every request has a
// 10 s budget, answers are capped, and redirects are refused, never followed.
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { NovaError } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import { hostPort } from './address.ts';

export const OOB_TIMEOUT_MS = 10_000;
/** Redfish answers are small; BIOS attribute lists stay well below this. */
export const REDFISH_MAX_BYTES = 2 * 1024 * 1024;

export type OobTransportFailure =
  'tls_pin_mismatch' | 'unreachable' | 'timeout' | 'tls_failed' | 'no_certificate' | 'too_large';

/** A failure below HTTP: the connection, the handshake, the pin or the size cap. */
export class OobTransportError extends Error {
  readonly failure: OobTransportFailure;
  /** The certificate pin the BMC presented (on a pin mismatch). */
  readonly presented: string | null;
  constructor(failure: OobTransportFailure, message: string, presented: string | null = null) {
    super(message);
    this.name = 'OobTransportError';
    this.failure = failure;
    this.presented = presented;
  }
}

export interface PinnedRequest {
  /** The BMC's name or address as the owner entered it (SNI and the Host header). */
  host: string;
  /** The checked IP address to connect to (default: `host`). */
  connectTo?: string;
  port: number;
  /** The pinned SHA-256 (lower-case hex) the BMC's certificate must have. */
  pin: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** How the Hub reaches a Redfish BMC; tests may wrap it, never replace the pin check. */
export interface RedfishTransport {
  /** The SHA-256 of the certificate the BMC presents now (a handshake only, no HTTP). */
  peerPin(host: string, port: number, timeoutMs: number, connectTo?: string): Promise<string>;
  request(r: PinnedRequest): Promise<PinnedResponse>;
}

export function certificatePin(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex');
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

function transportFailure(err: unknown): OobTransportError {
  if (err instanceof OobTransportError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  // The code decides first: a reset before the handshake is the network, not TLS.
  if (NETWORK_CODES.has(code))
    return new OobTransportError('unreachable', `the BMC could not be reached: ${code}`);
  if (/^ERR_SSL|^ERR_TLS|^EPROTO/.test(code) || (!code && /SSL|TLS/.test(message)))
    return new OobTransportError('tls_failed', `TLS with the BMC failed: ${message}`);
  return new OobTransportError('unreachable', `the BMC could not be reached: ${code || message}`);
}

function openTls(host: string, port: number, connectTo?: string): TLSSocket {
  return connect({
    host: connectTo ?? host,
    port,
    // SNI carries names only, never an IP literal.
    ...(isIP(host) ? {} : { servername: host }),
    // The chain is not trusted: the pin decides (checked before anything is sent).
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['http/1.1'],
  });
}

function presentedPin(socket: TLSSocket): string | null {
  const cert = socket.getPeerX509Certificate();
  return cert ? certificatePin(cert.raw) : null;
}

/** Connect, finish the handshake and report the certificate pin; then hang up. */
export function peerPin(
  host: string,
  port: number,
  timeoutMs: number,
  connectTo?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = openTls(host, port, connectTo);
    let settled = false;
    const done = (err: OobTransportError | null, pin?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(pin ?? '');
    };
    const timer = setTimeout(
      () => done(new OobTransportError('timeout', 'the BMC did not answer in time')),
      timeoutMs,
    );
    socket.on('error', (err) => done(transportFailure(err)));
    socket.once('secureConnect', () => {
      const pin = presentedPin(socket);
      if (!pin) done(new OobTransportError('no_certificate', 'the BMC presented no certificate'));
      else done(null, pin);
    });
  });
}

/** One HTTP/1.1 request on a fresh TLS connection whose certificate matches the pin. */
export function pinnedRequest(r: PinnedRequest): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const socket = openTls(r.host, r.port, r.connectTo);
    let settled = false;
    const done = (err: OobTransportError | null, res?: PinnedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (res) resolve(res);
    };
    const timer = setTimeout(
      () => done(new OobTransportError('timeout', 'the BMC did not answer in time')),
      r.timeoutMs,
    );
    socket.on('error', (err) => done(transportFailure(err)));
    socket.once('secureConnect', () => {
      const pin = presentedPin(socket);
      if (!pin) {
        done(new OobTransportError('no_certificate', 'the BMC presented no certificate'));
        return;
      }
      if (pin !== r.pin) {
        done(
          new OobTransportError(
            'tls_pin_mismatch',
            'the BMC presented a different certificate than the one pinned',
            pin,
          ),
        );
        return;
      }
      // Only now, on a connection whose certificate is the pinned one, is the request written.
      const req = httpRequest(
        {
          method: r.method,
          path: r.path,
          headers: {
            ...r.headers,
            host: hostPort(r.host, r.port),
            connection: 'close',
            ...(r.body !== undefined
              ? { 'content-length': String(Buffer.byteLength(r.body)) }
              : {}),
          },
          createConnection: () => socket,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > r.maxBytes) {
              done(new OobTransportError('too_large', 'the BMC answer was too large'));
              return;
            }
            chunks.push(c);
          });
          res.once('error', (err) => done(transportFailure(err)));
          res.once('end', () =>
            done(null, {
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.once('error', (err) => done(transportFailure(err)));
      req.end(r.body);
    });
  });
}

export const tlsRedfishTransport: RedfishTransport = { peerPin, request: pinnedRequest };

// ---- the client --------------------------------------------------------------------------------

export interface RedfishCredentials {
  username: string;
  password: string;
}

export type Json = Record<string, unknown>;

export function isJson(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A BMC failure as the Hub answers it: 409 `conflict` with the reason (or 403 for the pin). */
export function bmcError(reason: string, message: string, extra: Json = {}): NovaError {
  return new NovaError('conflict', message, { details: { reason, ...extra } });
}

/** The pin refusal: 403 `policy_denied` `{reason: tls_pin_mismatch, expected, presented}`. */
export function pinMismatchError(expected: string, presented: string | null): NovaError {
  return new NovaError(
    'policy_denied',
    'The BMC presented a different TLS certificate than the one pinned. If the BMC certificate was replaced on purpose, clear the pin and check again.',
    { details: { reason: 'tls_pin_mismatch', expected, presented } },
  );
}

const PATH = /^\/redfish\/v1(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?$/;

/** An `@odata.id` the BMC gave us, as a path on the same BMC (never a URL elsewhere). */
export function redfishPath(v: unknown): string {
  if (typeof v !== 'string' || v.length > 512 || !PATH.test(v) || v.includes('/../'))
    throw bmcError('bad_response', 'the BMC answered with an unexpected resource path');
  return v;
}

/** The `@odata.id` of a link object (`{"@odata.id": "..."}`), or null. */
export function odataId(v: unknown): string | null {
  return isJson(v) && typeof v['@odata.id'] === 'string' ? v['@odata.id'] : null;
}

function redfishMessage(text: string): string {
  let msg: string;
  try {
    const body = JSON.parse(text) as unknown;
    const err = isJson(body) && isJson(body.error) ? body.error : null;
    const ext = err?.['@Message.ExtendedInfo'];
    const first = Array.isArray(ext) && isJson(ext[0]) ? ext[0] : null;
    const m: unknown = first?.Message ?? err?.message;
    msg = typeof m === 'string' ? m : '';
  } catch {
    msg = text;
  }
  return defaultRedactor.redactString(msg.replace(/\s+/g, ' ').trim()).slice(0, 300);
}

/**
 * A BMC or ipmitool message with this session's password taken out. Local to the message: a
 * short or common password (`ADMIN`) is not made a redactor-wide literal (see the service).
 */
export function withoutSecret(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join('[redacted]') : text;
}

export interface RedfishClientOptions {
  host: string;
  /** The checked IP address to connect to (default: `host`). */
  connectTo?: string;
  port: number;
  pin: string;
  credentials: RedfishCredentials;
  transport?: RedfishTransport;
  timeoutMs?: number;
}

/** Redfish calls on one BMC, each on its own pinned connection with HTTP Basic credentials. */
export class RedfishClient {
  readonly #o: Required<Omit<RedfishClientOptions, 'transport' | 'connectTo'>> & {
    transport: RedfishTransport;
    connectTo?: string;
  };

  constructor(o: RedfishClientOptions) {
    this.#o = {
      ...o,
      transport: o.transport ?? tlsRedfishTransport,
      timeoutMs: o.timeoutMs ?? OOB_TIMEOUT_MS,
    };
  }

  async #send(
    method: PinnedRequest['method'],
    path: string,
    body?: Json,
    extra: Record<string, string> = {},
  ): Promise<PinnedResponse> {
    const { host, connectTo, port, pin, credentials, transport, timeoutMs } = this.#o;
    const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
    let res: PinnedResponse;
    try {
      res = await transport.request({
        host,
        ...(connectTo ? { connectTo } : {}),
        port,
        pin,
        method,
        path: redfishPath(path),
        headers: {
          accept: 'application/json',
          authorization: `Basic ${auth}`,
          'odata-version': '4.0',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        timeoutMs,
        maxBytes: REDFISH_MAX_BYTES,
      });
    } catch (err) {
      if (err instanceof NovaError) throw err;
      const t = transportFailure(err);
      if (t.failure === 'tls_pin_mismatch') throw pinMismatchError(pin, t.presented);
      throw bmcError(`bmc_${t.failure}`, t.message);
    }
    const s = res.status;
    if (s >= 200 && s < 300) return res;
    if (s >= 300 && s < 400)
      throw bmcError(
        'redirect_refused',
        'the BMC answered with a redirect, which is never followed',
        {
          status: s,
        },
      );
    if (s === 401 || s === 403)
      throw bmcError('bmc_auth_failed', 'the BMC refused the credentials', { status: s });
    if (s === 404) throw bmcError('bmc_not_found', `the BMC has no ${path}`, { status: s });
    if (s === 412)
      throw bmcError('bmc_precondition_failed', 'the BMC resource changed in the meantime', {
        status: s,
      });
    // A BMC may echo what it was sent: the password never reaches a message.
    const detail = withoutSecret(redfishMessage(res.text), credentials.password);
    if (s < 500)
      throw bmcError('bmc_refused', `the BMC refused the request${detail ? `: ${detail}` : ''}`, {
        status: s,
      });
    throw bmcError('bmc_error', `the BMC failed${detail ? `: ${detail}` : ''}`, { status: s });
  }

  /** GET a resource as JSON, with its ETag (header or `@odata.etag`) when it has one. */
  async get(path: string): Promise<{ json: Json; etag: string | null }> {
    const res = await this.#send('GET', path);
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : {};
    } catch {
      throw bmcError('bad_response', 'the BMC answer was not JSON');
    }
    if (!isJson(json)) throw bmcError('bad_response', 'the BMC answer was not a JSON object');
    const header = res.headers.etag;
    const etag =
      (typeof header === 'string' ? header : null) ??
      (typeof json['@odata.etag'] === 'string' ? json['@odata.etag'] : null);
    return { json, etag };
  }

  async patch(path: string, body: Json, etag: string | null = null): Promise<void> {
    await this.#send('PATCH', path, body, etag ? { 'if-match': etag } : {});
  }

  async post(path: string, body: Json): Promise<void> {
    await this.#send('POST', path, body);
  }
}

/** The service root, unauthenticated by the Redfish specification; used to learn the pin first. */
export async function redfishServiceRoot(
  transport: RedfishTransport,
  target: { host: string; connectTo?: string; port: number; pin: string },
  timeoutMs = OOB_TIMEOUT_MS,
): Promise<Json> {
  let res: PinnedResponse;
  try {
    res = await transport.request({
      ...target,
      method: 'GET',
      path: '/redfish/v1',
      headers: { accept: 'application/json', 'odata-version': '4.0' },
      timeoutMs,
      maxBytes: REDFISH_MAX_BYTES,
    });
  } catch (err) {
    const t = transportFailure(err);
    if (t.failure === 'tls_pin_mismatch') throw pinMismatchError(target.pin, t.presented);
    throw bmcError(`bmc_${t.failure}`, t.message);
  }
  if (res.status >= 300 && res.status < 400)
    throw bmcError(
      'redirect_refused',
      'the BMC answered with a redirect, which is never followed',
      {
        status: res.status,
      },
    );
  if (res.status !== 200)
    throw bmcError('not_redfish', 'the address does not answer as a Redfish service', {
      status: res.status,
    });
  try {
    const json = JSON.parse(res.text) as unknown;
    if (isJson(json)) return json;
  } catch {
    // below
  }
  throw bmcError('not_redfish', 'the address does not answer as a Redfish service');
}
