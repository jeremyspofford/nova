// A remote catalog for tests (FR-049): an HTTPS server on 127.0.0.1 with a self-signed
// certificate made by the repo's own X.509 builder, serving a fixed set of files, and a `fetch`
// that trusts only that certificate. Nothing here reaches the internet.
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { buildCertificate, KEY_USAGE, OID } from '../../../src/trust/x509.ts';

export interface FakeCatalogServer {
  /** `https://127.0.0.1:<port>`. */
  origin: string;
  /** Paths and their bytes; change them between requests. */
  files: Map<string, Uint8Array | string>;
  /** Redirects: path → location. */
  redirects: Map<string, string>;
  /** Paths requested, in order. */
  requests: string[];
  /** A fetch that trusts this server's certificate only. */
  fetch: typeof fetch;
  close(): Promise<void>;
}

export async function startFakeCatalog(): Promise<FakeCatalogServer> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const name = { commonName: 'fake-catalog', organization: 'Fake catalog' };
  const cert = buildCertificate({
    subject: name,
    issuer: name,
    publicKey,
    signer: privateKey,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    keyUsage: KEY_USAGE.digitalSignature,
    extKeyUsage: [OID.serverAuth],
    altNames: { hosts: ['127.0.0.1'] },
  }).pem;
  const files = new Map<string, Uint8Array | string>();
  const redirects = new Map<string, string>();
  const requests: string[] = [];
  const server: Server = createServer(
    { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert },
    (req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      requests.push(path);
      const to = redirects.get(path);
      if (to) {
        res.writeHead(302, { location: to });
        res.end();
        return;
      }
      const body = files.get(path);
      if (body === undefined) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(typeof body === 'string' ? body : Buffer.from(body));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `https://127.0.0.1:${port}`;

  const pinnedFetch = ((input: string | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      if (url.host !== `127.0.0.1:${port}`) {
        reject(new Error(`the test fetch reaches only ${origin}`));
        return;
      }
      const req = request(url, { method: init?.method ?? 'GET', ca: cert }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') headers.set(k, v);
          const status = res.statusCode ?? 500;
          resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers }));
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    })) as typeof fetch;

  return {
    origin,
    files,
    redirects,
    requests,
    fetch: pinnedFetch,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
