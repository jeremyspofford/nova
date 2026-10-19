// Fetch the Hub's identity statement on the very connection being checked (docs/22 §5 steps 2-3):
// open TLS without trusting anything yet, keep the chain the server presented, and ask
// `GET /api/v1/trust/identity?nonce=` on that same socket. Nothing else is sent: no cookie, no
// token, no code. Plain HTTP is only ever used for this computer's own loopback address.
import { request, type IncomingMessage } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { X509Certificate } from 'node:crypto';
import {
  checkServerIdentity,
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type TLSSocket,
} from 'node:tls';

export interface IdentityProbe {
  /** The HTTP status of the identity route. */
  status: number;
  /** The parsed JSON body, or null when it was not JSON. */
  body: unknown;
  /** The chain presented on this connection, leaf first; empty over plain HTTP. */
  chain: X509Certificate[];
  /** Whether the platform's trust store accepts the chain for this host (pinning `off`). */
  platformTrusted: boolean;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Roots to use instead of the platform's (tests). */
  ca?: string[];
}

const MAX_BODY = 64 * 1024;

/** True for this computer's own addresses: the only place plain HTTP is accepted. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

function chainOf(socket: TLSSocket): X509Certificate[] {
  const out: X509Certificate[] = [];
  const seen = new Set<string>();
  let cert: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
  while (cert && cert.raw && cert.raw.length > 0) {
    const key = cert.raw.toString('base64');
    if (seen.has(key)) break;
    seen.add(key);
    try {
      out.push(new X509Certificate(cert.raw));
    } catch {
      break;
    }
    cert = cert.issuerCertificate;
  }
  return out;
}

function open(
  url: URL,
  opts: ProbeOptions,
): Promise<{ socket: Socket; chain: X509Certificate[]; platformTrusted: boolean }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    if (url.protocol === 'http:') {
      const socket = netConnect({ host: hostname, port });
      socket.once('connect', () => resolve({ socket, chain: [], platformTrusted: false }));
      socket.once('error', reject);
      return;
    }
    const socket = tlsConnect({
      host: hostname,
      port,
      // SNI only for names (RFC 6066 §3): an address is never sent as a server name.
      ...(isIP(hostname) ? {} : { servername: hostname }),
      // Nothing is trusted yet: the statement decides, after the chain is in hand.
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.2',
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    socket.once('secureConnect', () => {
      const chain = chainOf(socket);
      const peer = socket.getPeerCertificate();
      const platformTrusted =
        socket.authorized && checkServerIdentity(hostname, peer) === undefined;
      resolve({ socket, chain, platformTrusted });
    });
    socket.once('error', reject);
  });
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.destroy(new Error('identity statement too large'));
        return;
      }
      parts.push(chunk);
    });
    res.once('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    res.once('error', reject);
  });
}

/** Ask the Hub at `origin` for its statement over one fresh connection. */
export async function probeIdentity(
  origin: string,
  nonce: string,
  opts: ProbeOptions = {},
): Promise<IdentityProbe> {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not an http(s) URL');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
    throw new Error('plain HTTP is used only for this computer');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let socket: Socket | null = null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      socket?.destroy();
      reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const run = async (): Promise<IdentityProbe> => {
    const opened = await open(url, opts);
    socket = opened.socket;
    const s = opened.socket;
    try {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request({
          method: 'GET',
          path: `/api/v1/trust/identity?nonce=${encodeURIComponent(nonce)}`,
          headers: { host: url.host, accept: 'application/json', connection: 'close' },
          // The request goes over the socket that presented the chain, never a new one.
          createConnection: () => s,
        });
        req.once('response', resolve);
        req.once('error', reject);
        req.end();
      });
      const text = await readBody(res);
      let body: unknown = null;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
      return {
        status: res.statusCode ?? 0,
        body,
        chain: opened.chain,
        platformTrusted: opened.platformTrusted,
      };
    } finally {
      s.destroy();
    }
  };
  const work = run();
  // Whichever loses the race must not surface as an unhandled rejection.
  work.catch(() => undefined);
  timeout.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
