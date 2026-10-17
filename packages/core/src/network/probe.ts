// The Hub's reachability probe of one of its own endpoints (FR-135, docs/22 §9.7): a real
// `GET <url>/api/v1/hello` with a short timeout over a fresh connection. It passes only when a
// Nova Hub answers. Once the Hub knows its own fingerprint, the answer must carry that same
// fingerprint (a missing one fails), and since a fingerprint is public, the endpoint must also
// prove it reaches this Hub: `GET /api/v1/trust/identity?nonce=<fresh nonce>` must return a
// statement for that nonce signed by the key the fingerprint pins (FR-134, docs/22 §5). HTTPS is
// verified against Node's default roots plus the Hub's own CA when the trust area gives one
// (never the Hub CA alone, which would fail every publicly issued certificate), so an endpoint a
// client could not verify is not advertised either.
import { randomBytes, verify } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { getCACertificates } from 'node:tls';
import { z } from 'zod';
import { hubIdentityStatementBytes, type EndpointProbeOutcome } from '@nova/shared';
import { ed25519FromRaw, hubFingerprint } from '../trust/identity.ts';

export interface HelloProbeOptions {
  /** Give up after this long, every request included (default 300 ms, docs/22 §2). */
  timeoutMs?: number;
  /** Connect to this address but keep the URL's host name for Host and TLS (an mDNS name). */
  connectAddress?: string;
  /** The Hub's CA (PEM), trusted for https URLs on top of the default roots. */
  ca?: string | null;
  /**
   * The Hub's own fingerprint: the hello must carry it, and the endpoint must answer a fresh
   * nonce with a statement signed by the key it pins.
   */
  expectFingerprint?: string | null;
  /** Millisecond clock for the latency (default `performance.now`). */
  clock?: () => number;
}

export interface HelloProbeResult extends EndpointProbeOutcome {
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}

/** Probe a Hub base URL; the default `HubProbe` of the endpoint registry. */
export type HubProbe = (url: string, opts: HelloProbeOptions) => Promise<HelloProbeResult>;

const MAX_BODY = 64 * 1024;

// The signed part of `GET /api/v1/trust/identity` (packages/shared m65/trust.ts).
const statementSchema = z.object({
  v: z.literal(1),
  nonce: z.string(),
  hubFingerprint: z.string(),
  hubPublicKey: z.string(),
  pinning: z.enum(['required', 'off']),
  certificates: z.array(
    z.object({
      kind: z.enum(['ca', 'leaf', 'mesh']),
      sha256: z.string(),
      notAfter: z.string(),
    }),
  ),
  issuedAt: z.string(),
  signature: z.string(),
});

function fixedLookup(address: string): LookupFunction {
  const family = isIP(address) || 4;
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function errorDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? '';
  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the name does not resolve';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'no route to the address';
    case 'ECONNRESET':
      return 'the connection was reset';
    default:
      break;
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME/i.test(code))
    return `the certificate does not verify (${code})`;
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200) || 'unreachable';
}

type Answer = { ok: true; status: number; body: unknown } | { ok: false; detail: string };

/** One GET with a deadline, over its own connection; the body parsed as JSON (null if not). */
function getJson(target: URL, opts: HelloProbeOptions, deadline: number): Promise<Answer> {
  const https = target.protocol === 'https:';
  return new Promise<Answer>((resolve) => {
    let finished = false;
    const done = (a: Answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      resolve(a);
    };
    const fail = (detail: string) => done({ ok: false, detail });
    const options = {
      method: 'GET',
      headers: { accept: 'application/json' },
      // A fresh connection per probe: a pooled socket would hide a dead path.
      agent: false as const,
      ...(opts.connectAddress ? { lookup: fixedLookup(opts.connectAddress) } : {}),
      // `ca` replaces the default roots, so they are passed along with the Hub's CA.
      ...(https && opts.ca ? { ca: [...getCACertificates('default'), opts.ca] } : {}),
    };
    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) fail('the answer is too large');
        else chunks.push(c);
      });
      res.on('error', (err) => fail(errorDetail(err)));
      res.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          body = null;
        }
        done({ ok: true, status: res.statusCode ?? 0, body });
      });
    };
    const req = (https ? httpsRequest : httpRequest)(target, options, onResponse);
    req.on('error', (err) => fail(errorDetail(err)));
    const timer = setTimeout(() => fail('timed out'), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    req.end();
  });
}

/** Why a statement does not prove this Hub for `nonce`, or null when it does. */
function statementProblem(body: unknown, nonce: string, pin: string): string | null {
  const parsed = statementSchema.safeParse(body);
  if (!parsed.success) return 'no signed identity statement';
  const { signature, ...unsigned } = parsed.data;
  if (unsigned.nonce !== nonce) return 'the identity statement is not for this request';
  let key;
  try {
    key = ed25519FromRaw(unsigned.hubPublicKey);
  } catch {
    return 'another Hub answered';
  }
  if (
    unsigned.hubFingerprint !== pin ||
    hubFingerprint(Buffer.from(unsigned.hubPublicKey, 'base64url')) !== pin
  )
    return 'another Hub answered';
  const ok = verify(
    null,
    Buffer.from(hubIdentityStatementBytes(unsigned)),
    key,
    Buffer.from(signature, 'base64url'),
  );
  return ok ? null : 'the identity signature does not verify';
}

export const probeHello: HubProbe = async (url, opts) => {
  const timeoutMs = opts.timeoutMs ?? 300;
  const clock = opts.clock ?? (() => performance.now());
  const base = url.replace(/\/+$/, '');
  let hello: URL;
  try {
    hello = new URL(`${base}/api/v1/hello`);
  } catch {
    return { ok: false, latencyMs: null, detail: 'not a URL' };
  }
  if (hello.protocol !== 'https:' && hello.protocol !== 'http:')
    return { ok: false, latencyMs: null, detail: 'not an http(s) URL' };
  const fail = (detail: string): HelloProbeResult => ({ ok: false, latencyMs: null, detail });
  const deadline = Date.now() + timeoutMs;
  const started = clock();
  const a = await getJson(hello, opts, deadline);
  if (!a.ok) return fail(a.detail);
  const latencyMs = Math.max(0, Math.round(clock() - started));
  if (a.status === 403)
    return fail('the Hub refused this host name; add it to the allowed origins');
  if (a.status !== 200) return fail(`HTTP ${a.status}`);
  const answer = (a.body ?? {}) as { name?: unknown; hubFingerprint?: unknown };
  if (answer.name !== 'nova-hub') return fail('not a Nova Hub');
  const pin = opts.expectFingerprint;
  if (!pin) return { ok: true, latencyMs, detail: null };
  if (typeof answer.hubFingerprint !== 'string')
    return fail('the answer carries no Hub fingerprint');
  if (answer.hubFingerprint !== pin) return fail('another Hub answered');
  // The fingerprint is public: only a statement signed for our own nonce proves this Hub.
  const nonce = randomBytes(24).toString('base64url');
  const b = await getJson(new URL(`${base}/api/v1/trust/identity?nonce=${nonce}`), opts, deadline);
  if (!b.ok) return fail(b.detail);
  if (b.status !== 200) return fail(`the Hub identity could not be proven (HTTP ${b.status})`);
  const problem = statementProblem(b.body, nonce, pin);
  return problem ? fail(problem) : { ok: true, latencyMs, detail: null };
};
