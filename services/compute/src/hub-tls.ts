// TLS to the Hub for the compute node (FR-126, FR-134; docs/22 §5 native-shell pinning; R-022).
// With the fingerprint pinned at Add Device (`--pin`), a Hub certificate is trusted when it was
// issued by the Hub local CA learned from a verified identity statement (issuer, signature,
// serverAuth, a name for the host dialed, validity), or when a verified statement listed its
// SHA-256 (the Hub's leaf or a mesh certificate). Otherwise the connection is provisional: before
// anything else crosses it, the node asks the Hub on that same connection for its identity
// statement with a fresh nonce and checks it as `checkHubIdentity` in @nova/core does. What a
// statement vouched for is kept (`onTrust`) for later connections. The node has no use for the
// platform's roots once it pinned the Hub, so `pinning: off` changes nothing (stricter, never
// weaker).
//
// With the device certificate Add Device granted (local-CA mode), every trusted connection
// presents it, signed with the node's own Ed25519 key (mutual TLS). A provisional connection
// never does: the certificate names the node, so it is sent only to a Hub already verified.
import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { connect, rootCertificates, type PeerCertificate, type TLSSocket } from 'node:tls';
import { hubIdentityStatementBytes, type HubIdentityStatement } from '@nova/shared';

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** A certificate a verified statement listed (the Hub's leaf or a mesh certificate). */
export interface ListedCertificate {
  /** SHA-256 of the DER, lowercase hex. */
  sha256: string;
  notAfter: string;
}

/** What the node trusts about its Hub. */
export interface HubTrust {
  /** base64url(SHA-256(the Hub identity's raw Ed25519 key)), from Add Device or `--pin`. */
  pin: string | null;
  /** The Hub local CA (PEM) a verified statement vouched for. */
  caPem: string | null;
  listed: ListedCertificate[];
}

export interface ClientCertificate {
  certPem: string;
  /** The node's own key (PKCS#8 PEM), the one the certificate certifies. */
  keyPem: string;
}

export type StatementRefusal =
  | 'pin_mismatch'
  | 'bad_signature'
  | 'nonce_mismatch'
  | 'no_certificate'
  | 'not_listed'
  | 'not_server_certificate'
  | 'host_mismatch'
  | 'expired';

/** The Hub's certificate is not vouched for by the pinned identity: nothing was sent. */
export class HubTrustError extends Error {
  readonly reason: StatementRefusal | 'untrusted';
  constructor(reason: StatementRefusal | 'untrusted', message?: string) {
    super(
      message ??
        `this is not your Hub: its certificate is not vouched for by the pinned Hub identity (${reason}); nothing was sent`,
    );
    this.name = 'HubTrustError';
    this.reason = reason;
  }
}

function sha256Hex(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function within(x: X509Certificate, now: number): boolean {
  return now >= Date.parse(x.validFrom) && now <= Date.parse(x.validTo);
}

function hostMatches(x: X509Certificate, host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return Boolean(isIP(h) ? x.checkIP(h) : x.checkHost(h, { subject: 'never' }));
}

// ---- name constraints (RFC 5280 §4.2.1.10) ---------------------------------------------------
// The Hub local CA carries name constraints so the root a device trusts can never vouch for anyone
// else's site (docs/22 §5); novad's TLS stack (webpki) enforces them, and so does this check.
// Node's X509Certificate does not expose them, so the extensions are read from the DER.

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

/** One DER element at `at` (definite lengths only), or null when malformed. */
function tlv(der: Buffer, at: number, limit = der.length): Tlv | null {
  if (at + 2 > limit) return null;
  const tag = der[at]!;
  let len = der[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i]!;
    start += n;
  }
  const end = start + len;
  return end > limit ? null : { tag, start, end };
}

function children(der: Buffer, parent: Tlv): Tlv[] | null {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end;) {
    const t = tlv(der, at, parent.end);
    if (!t) return null;
    out.push(t);
    at = t.end;
  }
  return out;
}

/** The value (inside the OCTET STRING) of an extension, by its OID's DER bytes. */
function extension(der: Buffer, oid: string): Buffer | null | 'malformed' {
  const cert = tlv(der, 0);
  const tbs = cert && tlv(der, cert.start, cert.end);
  const fields = tbs && children(der, tbs);
  if (!fields) return 'malformed';
  const exts = fields.find((f) => f.tag === 0xa3);
  if (!exts) return null;
  const list = tlv(der, exts.start, exts.end);
  const items = list && children(der, list);
  if (!items) return 'malformed';
  for (const item of items) {
    const parts = children(der, item);
    if (!parts?.[0]) return 'malformed';
    if (der.subarray(parts[0].start, parts[0].end).toString('hex') !== oid) continue;
    const value = parts.at(-1)!;
    if (value.tag !== 0x04) return 'malformed';
    return der.subarray(value.start, value.end);
  }
  return null;
}

const OID_SAN = '551d11'; // 2.5.29.17
const OID_NAME_CONSTRAINTS = '551d1e'; // 2.5.29.30

/** GeneralNames as (tag, bytes): dNSName is 0x82, iPAddress 0x87 (others kept by tag). */
function generalNames(der: Buffer): { tag: number; value: Buffer }[] | null {
  const seq = tlv(der, 0);
  const items = seq && children(der, seq);
  return items ? items.map((i) => ({ tag: i.tag, value: der.subarray(i.start, i.end) })) : null;
}

function dnsWithin(name: string, base: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  const b = base.toLowerCase();
  if (b === '') return true;
  if (b.startsWith('.')) return n.endsWith(b);
  return n === b || n.endsWith(`.${b}`);
}

function ipWithin(addr: Buffer, range: Buffer): boolean {
  if (range.length !== addr.length * 2) return false;
  for (let i = 0; i < addr.length; i++) {
    const mask = range[addr.length + i]!;
    if ((addr[i]! & mask) !== (range[i]! & mask)) return false;
  }
  return true;
}

function nameWithin(tag: number, value: Buffer, base: Buffer): boolean {
  if (tag === 0x82) return dnsWithin(value.toString('ascii'), base.toString('ascii'));
  if (tag === 0x87) return ipWithin(value, base);
  return false;
}

/**
 * Whether every name the leaf certifies is allowed by the CA's name constraints: inside a
 * permitted subtree of its kind when the CA permits any of that kind, and inside no excluded one.
 * A constraint or name this check cannot read refuses (fail closed).
 */
export function nameConstraintsAllow(ca: X509Certificate, leaf: X509Certificate): boolean {
  const nc = extension(ca.raw, OID_NAME_CONSTRAINTS);
  if (nc === 'malformed') return false;
  if (nc === null) return true;
  const outer = tlv(nc, 0);
  const parts = outer && children(nc, outer);
  if (!parts) return false;
  const subtrees = (tag: number): { tag: number; value: Buffer }[] | null => {
    const part = parts.find((p) => p.tag === tag);
    if (!part) return [];
    const list = children(nc, part);
    if (!list) return null;
    const out: { tag: number; value: Buffer }[] = [];
    for (const sub of list) {
      const base = tlv(nc, sub.start, sub.end);
      if (!base) return null;
      out.push({ tag: base.tag, value: nc.subarray(base.start, base.end) });
    }
    return out;
  };
  const permitted = subtrees(0xa0);
  const excluded = subtrees(0xa1);
  if (!permitted || !excluded) return false;
  const san = extension(leaf.raw, OID_SAN);
  if (san === 'malformed') return false;
  const names = san ? generalNames(san) : [];
  if (!names) return false;
  for (const n of names) {
    const sameKind = permitted.filter((p) => p.tag === n.tag);
    if (
      n.tag !== 0x82 &&
      n.tag !== 0x87 &&
      (sameKind.length || excluded.some((e) => e.tag === n.tag))
    )
      return false;
    if (sameKind.length && !sameKind.some((p) => nameWithin(n.tag, n.value, p.value))) return false;
    if (excluded.some((e) => e.tag === n.tag && nameWithin(n.tag, n.value, e.value))) return false;
  }
  return true;
}

/**
 * A server certificate (not a CA, serverAuth) for `host`, issued by `ca` and within its name
 * constraints, within its validity.
 */
function issuedFor(leaf: X509Certificate, ca: X509Certificate, host: string, now: number) {
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return 'not_listed' as const;
  // A name outside what the CA may vouch for: as for novad (webpki), the CA does not vouch.
  if (!nameConstraintsAllow(ca, leaf)) return 'not_listed' as const;
  // Device certificates (client authentication only) and CAs are never a Hub.
  if (leaf.ca || !(leaf.keyUsage ?? []).includes(SERVER_AUTH))
    return 'not_server_certificate' as const;
  if (!hostMatches(leaf, host)) return 'host_mismatch' as const;
  return within(leaf, now) ? null : ('expired' as const);
}

/**
 * Steps 4-6 of docs/22 §5 for one connection: the statement's key hashes to the pin, its
 * signature verifies, it carries this nonce, and it vouches for the chain shown (leaf first).
 * Returns the CA in the chain the statement lists, for the cache.
 */
export function checkStatement(input: {
  statement: HubIdentityStatement;
  pin: string;
  nonce: string;
  host: string;
  chain: X509Certificate[];
  now?: number;
}): { ok: true; ca: X509Certificate | null } | { ok: false; reason: StatementRefusal } {
  const s = input.statement;
  const fail = (reason: StatementRefusal) => ({ ok: false, reason }) as const;
  if (typeof s.hubPublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.hubPublicKey))
    return fail('pin_mismatch');
  const raw = Buffer.from(s.hubPublicKey, 'base64url');
  if (
    s.hubFingerprint !== input.pin ||
    createHash('sha256').update(raw).digest('base64url') !== input.pin
  )
    return fail('pin_mismatch');
  const { signature, ...unsigned } = s;
  let good: boolean;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: s.hubPublicKey },
      format: 'jwk',
    });
    good =
      typeof signature === 'string' &&
      verify(
        null,
        Buffer.from(hubIdentityStatementBytes(unsigned)),
        key,
        Buffer.from(signature, 'base64url'),
      );
  } catch {
    good = false;
  }
  if (!good) return fail('bad_signature');
  if (s.nonce !== input.nonce) return fail('nonce_mismatch');
  const leaf = input.chain[0];
  if (!leaf) return fail('no_certificate');
  const now = input.now ?? Date.now();
  const caHash = s.certificates.find((c) => c.kind === 'ca')?.sha256;
  const ca = (caHash && input.chain.find((c) => sha256Hex(c.raw) === caHash)) || null;
  const leafHash = sha256Hex(leaf.raw);
  if (s.certificates.some((c) => (c.kind === 'leaf' || c.kind === 'mesh') && c.sha256 === leafHash))
    return within(leaf, now) ? { ok: true, ca } : fail('expired');
  if (!ca) return fail('not_listed');
  const why = issuedFor(leaf, ca, input.host, now);
  return why ? fail(why) : { ok: true, ca };
}

/** The chain the server showed, leaf first. */
function chainOf(socket: TLSSocket): X509Certificate[] {
  return chainFrom(socket.getPeerCertificate(true));
}

/** The chain of a detailed peer certificate (`issuerCertificate` links), leaf first. */
function chainFrom(peer: PeerCertificate | undefined): X509Certificate[] {
  const out: X509Certificate[] = [];
  const seen = new Set<string>();
  let c = peer as
    { raw?: Buffer; fingerprint256?: string; issuerCertificate?: unknown } | undefined;
  while (c?.raw && c.fingerprint256 && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    out.push(new X509Certificate(c.raw));
    c = c.issuerCertificate as typeof c;
  }
  return out;
}

/** A chunked body when complete: the decoded bytes and where it ended; null while incomplete. */
function dechunk(buf: Buffer): { body: Buffer; end: number } | null | Error {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', at);
    if (eol < 0) return null;
    const size = parseInt(buf.subarray(at, eol).toString('latin1').split(';')[0] ?? '', 16);
    if (!Number.isInteger(size) || size < 0) return new Error('the Hub sent a malformed chunk');
    if (size === 0) {
      const end = buf.indexOf('\r\n', eol + 2);
      return end < 0 ? null : { body: Buffer.concat(parts), end: end + 2 };
    }
    if (buf.length < eol + 2 + size + 2) return null;
    parts.push(buf.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}

/** One HTTP/1.1 exchange on an open socket, keeping it open for the request that follows. */
function exchange(
  socket: TLSSocket,
  authority: string,
  path: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err: Error | null, value?: { status: number; body: Buffer }) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) reject(err);
      else resolve(value!);
    };
    const onError = (err: Error) => done(err);
    const onClose = () => done(new Error('the Hub closed the connection'));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 256 * 1024) return done(new Error('the Hub sent too much'));
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1] ?? NaN);
      const field = (name: string) =>
        head
          .find((l) => l.toLowerCase().startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim();
      if (!Number.isInteger(status)) return done(new Error('the Hub sent an unexpected answer'));
      const rest = buf.subarray(end + 4);
      if (field('transfer-encoding')?.toLowerCase() === 'chunked') {
        const body = dechunk(rest);
        if (body instanceof Error) return done(body);
        if (!body) return;
        if (body.end !== rest.length) return done(new Error('the Hub sent more than one answer'));
        return done(null, { status, body: body.body });
      }
      const length = Number(field('content-length') ?? NaN);
      if (!Number.isInteger(length)) return done(new Error('the Hub sent an unframed answer'));
      if (rest.length < length) return;
      if (rest.length > length) return done(new Error('the Hub sent more than one answer'));
      done(null, { status, body: rest });
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nAccept: application/json\r\nUser-Agent: nova-compute\r\nConnection: keep-alive\r\n\r\n`,
    );
  });
}

export interface HubTlsOptions {
  trust: HubTrust;
  client?: ClientCertificate | null;
  /** Called with what a verified statement vouched for (the node saves it). */
  onTrust?: (trust: HubTrust) => void;
  /** The TLS handshake and the identity statement time out after this (default 10 s). */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * A `fetch` for the Hub: https:// URLs go through the pinned trust (and present the device
 * certificate); http:// URLs use the platform's fetch.
 */
export class HubTls {
  #trust: HubTrust;
  readonly #client: ClientCertificate | null;
  readonly #onTrust: ((t: HubTrust) => void) | null;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(opts: HubTlsOptions) {
    this.#trust = { ...opts.trust, listed: [...opts.trust.listed] };
    this.#client = opts.client ?? null;
    this.#onTrust = opts.onTrust ?? null;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  get trust(): HubTrust {
    return { ...this.#trust, listed: [...this.#trust.listed] };
  }

  /** Whether the cached trust vouches for this chain on a connection to `host`. */
  #vouches(chain: X509Certificate[], host: string): boolean {
    const leaf = chain[0];
    if (!leaf) return false;
    const now = this.#now();
    if (this.#trust.caPem) {
      try {
        if (issuedFor(leaf, new X509Certificate(this.#trust.caPem), host, now) === null)
          return true;
      } catch {
        // an unreadable cached CA vouches for nothing
      }
    }
    const hash = sha256Hex(leaf.raw);
    return this.#trust.listed.some(
      (l) => l.sha256 === hash && Date.parse(l.notAfter) >= now && within(leaf, now),
    );
  }

  #open(host: string, port: number, withCert: boolean): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const bare = host.replace(/^\[|\]$/g, '');
      const present = withCert ? this.#client : null;
      const socket = connect({
        host: bare,
        port,
        ...(isIP(bare) ? {} : { servername: bare }),
        ALPNProtocols: ['http/1.1'],
        ...(present
          ? {
              cert: present.certPem,
              key: present.keyPem,
              // The device certificate goes only to a server verified in the handshake itself:
              // TLS 1.3 sends it in the client's last flight, which never leaves when the server's
              // chain or the cached trust (checkServerIdentity) refuses (FR-126, ADR-095).
              minVersion: 'TLSv1.3' as const,
              rejectUnauthorized: true,
              ca: [...(this.#trust.caPem ? [this.#trust.caPem] : []), ...rootCertificates],
              checkServerIdentity: (_name: string, cert: PeerCertificate) =>
                this.#vouches(chainFrom(cert), host)
                  ? undefined
                  : new HubTrustError(
                      'untrusted',
                      'the cached Hub trust does not vouch for this certificate',
                    ),
            }
          : {
              // Provisional: the chain is checked against the pinned identity before anything
              // is sent, and no certificate names this node to it.
              rejectUnauthorized: false,
            }),
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to the Hub at ${host}:${port}`));
      }, this.#timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** A connection this trust vouches for (checking the statement on it when needed). */
  async connect(host: string, port: number): Promise<TLSSocket> {
    const authority = `${host}:${port}`;
    if (this.#client && (this.#trust.caPem || this.#trust.listed.length)) {
      try {
        const s = await this.#open(host, port, true);
        if (this.#vouches(chainOf(s), host)) return s;
        s.destroy();
      } catch {
        // Not vouched for (or not reachable): check on a connection that names nobody.
      }
    }
    const s = await this.#open(host, port, false);
    const chain = chainOf(s);
    if (!this.#vouches(chain, host)) {
      const pin = this.#trust.pin;
      if (!pin) {
        s.destroy();
        throw new HubTrustError(
          'untrusted',
          'the Hub’s certificate is not trusted and no Hub fingerprint is pinned',
        );
      }
      try {
        await this.#verify(s, pin, host, authority, chain);
      } catch (err) {
        s.destroy();
        throw err;
      }
    }
    if (!this.#client) return s;
    s.destroy();
    let again: TLSSocket;
    try {
      again = await this.#open(host, port, true);
    } catch (err) {
      throw new HubTrustError(
        'untrusted',
        `the Hub showed a different certificate on the next connection (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (this.#vouches(chainOf(again), host)) return again;
    again.destroy();
    throw new HubTrustError(
      'untrusted',
      'the Hub showed a different certificate on the next connection',
    );
  }

  async #verify(
    socket: TLSSocket,
    pin: string,
    host: string,
    authority: string,
    chain: X509Certificate[],
  ): Promise<void> {
    const nonce = randomBytes(24).toString('base64url');
    const timer = setTimeout(() => socket.destroy(new Error('timed out')), this.#timeoutMs);
    let answer: { status: number; body: Buffer };
    try {
      answer = await exchange(socket, authority, `/api/v1/trust/identity?nonce=${nonce}`);
    } finally {
      clearTimeout(timer);
    }
    if (answer.status !== 200)
      throw new HubTrustError(
        'untrusted',
        `the Hub answered ${answer.status} for its identity statement`,
      );
    let statement: HubIdentityStatement;
    try {
      statement = JSON.parse(answer.body.toString('utf8')) as HubIdentityStatement;
    } catch {
      throw new HubTrustError('bad_signature');
    }
    const r = checkStatement({ statement, pin, nonce, host, chain, now: this.#now() });
    if (!r.ok) throw new HubTrustError(r.reason);
    this.learn(statement, r.ca);
  }

  /** Keep what a verified statement vouched for. */
  learn(statement: HubIdentityStatement, ca: X509Certificate | null): void {
    const listsCa = statement.certificates.some((c) => c.kind === 'ca');
    this.#trust = {
      pin: this.#trust.pin,
      caPem: ca ? ca.toString() : listsCa ? this.#trust.caPem : null,
      listed: statement.certificates
        .filter((c) => c.kind === 'leaf' || c.kind === 'mesh')
        .map((c) => ({ sha256: c.sha256, notAfter: c.notAfter })),
    };
    this.#onTrust?.(this.trust);
  }

  /** `fetch` over this trust for https:// URLs; http:// goes to `plain`. */
  fetch(plain: typeof fetch = (...a) => fetch(...a)): typeof fetch {
    return async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.protocol !== 'https:') return plain(input, init);
      const port = Number(url.port || 443);
      const socket = await this.connect(url.hostname, port);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      return new Promise<Response>((resolve, reject) => {
        const req = request(
          {
            method: init?.method ?? 'GET',
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port,
            path: `${url.pathname}${url.search}`,
            headers: {
              ...Object.fromEntries(headers.entries()),
              ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
              connection: 'close',
            },
            // No agent: the request goes over this connection, which already passed the checks
            // above (an agent would open its own, unchecked one).
            createConnection: () => socket,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && init?.redirect === 'error') {
              res.destroy();
              reject(new TypeError('the Hub answered with a redirect'));
              return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('error', reject);
            res.on('end', () => {
              const out = new Headers();
              for (const [k, v] of Object.entries(res.headers))
                if (typeof v === 'string') out.set(k, v);
              resolve(
                new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), {
                  status,
                  headers: out,
                }),
              );
            });
          },
        );
        req.on('error', reject);
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) req.destroy(new Error('aborted'));
          else
            signal.addEventListener('abort', () => req.destroy(new Error('aborted')), {
              once: true,
            });
        }
        if (body !== undefined) req.write(body);
        req.end();
      });
    };
  }
}

/**
 * Learn the Hub local CA over plain HTTP at enrollment: the statement is signed by the pinned
 * identity and carries this request's nonce, so the CA it lists (by SHA-256) is the Hub's even
 * though the connection is not secret; later HTTPS then trusts certificates it issued. Returns
 * the trust to keep (unchanged when the Hub has no local CA or does not answer).
 */
export async function learnCaOverHttp(
  hubUrl: string,
  trust: HubTrust,
  fetchFn: typeof fetch,
): Promise<HubTrust> {
  if (!trust.pin) return trust;
  const nonce = randomBytes(24).toString('base64url');
  const res = await fetchFn(`${hubUrl}/api/v1/trust/identity?nonce=${nonce}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return trust;
  const statement = (await res.json()) as HubIdentityStatement;
  const signed = checkStatement({ statement, pin: trust.pin, nonce, host: '', chain: [] });
  // Over HTTP there is no chain: everything but the certificate match must hold.
  if (!signed.ok && signed.reason !== 'no_certificate') throw new HubTrustError(signed.reason);
  const want = statement.certificates.find((c) => c.kind === 'ca')?.sha256;
  const listed = statement.certificates
    .filter((c) => c.kind === 'leaf' || c.kind === 'mesh')
    .map((c) => ({ sha256: c.sha256, notAfter: c.notAfter }));
  if (!want) return { pin: trust.pin, caPem: null, listed };
  const pem = await fetchFn(`${hubUrl}/api/v1/trust/ca.pem`);
  const ca = pem.ok ? new X509Certificate(await pem.text()) : null;
  if (!ca || sha256Hex(ca.raw) !== want)
    throw new HubTrustError(
      'not_listed',
      'the Hub’s CA certificate does not match its signed identity statement',
    );
  return { pin: trust.pin, caPem: ca.toString(), listed };
}
