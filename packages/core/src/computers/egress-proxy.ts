// The egress proxy (FR-102, FR-193, docs/12 §8, docs/11 §7, ADR-063): every sandbox reaches the
// network only through it. One session per sandbox, each with its own listeners: a Unix socket
// the substrate bridges into the sandbox (its only route out) and, for host-side clients, a
// loopback TCP port that needs the session's token. The session's policy decides each request:
//
// - mode `off` blocks everything; deny entries win; hosts must be on the allowlist (a bare `*`
//   is rejected when the policy loads); `limited` allows only GET, HEAD and OPTIONS.
// - The proxy resolves DNS itself, after the host checks pass, and pins the resolved address for
//   the connection. Private, loopback, link-local, CGNAT, unique-local and multicast addresses
//   are blocked unless the policy allows local binding and a dev-server grant covers the host
//   and port. The proxy never follows redirects: the client's next request is checked anew.
// - HTTPS is inspected (TLS terminated with the per-Hub CA) when the mode is `limited`, when a
//   credential is bound to the host, or when a stripping hook matches it; otherwise CONNECT is
//   an opaque tunnel to the pinned address. Without a CA, `limited` blocks HTTPS ("HTTPS that
//   cannot be inspected is blocked") and credentials are injected over plain HTTP only.
// - Credentials (ADR-063) are resolved from the vault per request and added to requests to
//   their hosts; the sandbox never sees them, and their values are masked in the response.
// - Tracking and forwarding headers are stripped; hooks can strip a header or cookies, or block.
// - A blocked request gets 403 with `X-Nova-Block-Cause` and a short body naming the host. Every
//   decision, allow or deny, is audited (kind `network`) without bodies or full URLs.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  connect as netConnect,
  createServer as createNetServer,
  isIP,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { rootCertificates, TLSSocket } from 'node:tls';
import { NovaError, uuidv7, type EgressHook } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import type { AuditSink } from '../tools/types.ts';
import type { CertificateAuthority } from './egress-ca.ts';
import {
  addressAllowed,
  classifyAddress,
  decideHost,
  matchingPattern,
  normalizeHost,
  validateEgressPolicy,
  type AddressClass,
} from './egress-policy.ts';
import type { EgressBlockCause, EgressPolicy, EgressProxy, EgressSession } from './types.ts';

/** A credential bound to hosts; the value is read from the vault per request (ADR-063). */
export interface EgressCredential {
  id: string;
  hosts: string[];
  scheme: 'bearer' | 'basic' | 'header';
  header: string | null;
  username: string | null;
  value: () => Promise<string | null>;
}

/** A session's policy plus its stripping hooks (docs/12 §8). */
export type ProxyPolicy = EgressPolicy & { hooks?: EgressHook[] };

export type EgressScope = { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string };

export interface EgressProxyOptions {
  /** The per-Hub CA; null means HTTPS cannot be inspected. */
  ca?: CertificateAuthority | null;
  audit?: AuditSink;
  /** The account's credentials among `ids` (metadata now, values on demand). */
  credentials?: (accountId: string, ids: readonly string[]) => Promise<EgressCredential[]>;
  /** DNS (all addresses of a name); defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Address classes; tests may treat their loopback upstream as public. */
  classify?: (address: string) => AddressClass;
  /** Dev-server grants from elsewhere (docs/12 §4.2), besides `grantDevServer`. */
  devServerGrant?: (input: {
    accountId: string;
    scope: EgressScope;
    host: string;
    port: number;
  }) => boolean;
  /** Extra CAs trusted for upstream TLS (a private registry; tests). */
  upstreamCa?: string[];
  /** Where session sockets live; a short path (Unix socket paths are limited to ~100 bytes). */
  socketDir?: string;
  /**
   * Who may connect to a session's socket: only the Hub's user (default; the substrates run
   * sandboxes as that user), or everyone, for a Hub running as root whose sandboxes run as
   * nobody. The socket path shows in the engine's command line, so it is not a secret.
   */
  socketAccess?: 'owner' | 'everyone';
  connectTimeoutMs?: number;
  /** An idle tunnel or connection is closed after this long (default 10 min). */
  idleTimeoutMs?: number;
  log?: Logger;
}

/** What substrates need from a session beyond the seam: the socket to bridge in. */
export interface LocalEgressSession extends EgressSession {
  readonly id: string;
  /** Folder holding the socket and the CA bundle; mount it into the sandbox. */
  readonly dir: string;
  /** File names inside `dir`. */
  readonly socketName: string;
  readonly caBundleName: string | null;
}

/** Headers never forwarded: hop-by-hop, proxy and tracking or forwarding headers. */
const STRIP_REQUEST = new Set([
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'x-cluster-client-ip',
  'x-originating-ip',
  'traceparent',
  'tracestate',
  'b3',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-parentspanid',
  'x-b3-sampled',
  'x-b3-flags',
  'x-cloud-trace-context',
  'x-amzn-trace-id',
]);
const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REASONS: Record<EgressBlockCause, string> = {
  allowlist: 'the host is not on the network allowlist',
  denylist: 'the host is on the network denylist',
  method: 'only GET, HEAD and OPTIONS are allowed in limited network mode',
  private_address: 'the host is, or resolves to, a private, loopback or link-local address',
  inspection: 'HTTPS that cannot be inspected is blocked in limited network mode',
  policy: 'network access is off for this sandbox, or a network rule blocks this request',
};

function blockBody(host: string, cause: EgressBlockCause): string {
  return `Nova blocked this request to ${host}: ${REASONS[cause]}.\nTo request access, ask in Nova or add the host in Settings > Network.\n`;
}

/** Masks every occurrence of the needles in a stream, across chunk boundaries. */
class Masker extends Transform {
  readonly #needles: Buffer[];
  readonly #keep: number;
  #tail: Buffer = Buffer.alloc(0);
  constructor(needles: string[]) {
    super();
    this.#needles = needles.filter((n) => n.length >= 4).map((n) => Buffer.from(n));
    this.#keep = Math.max(0, ...this.#needles.map((n) => n.length - 1));
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = this.#mask(Buffer.concat([this.#tail, chunk]));
    const cut = Math.max(0, buf.length - this.#keep);
    this.#tail = buf.subarray(cut);
    if (cut) this.push(buf.subarray(0, cut));
    cb();
  }
  override _flush(cb: TransformCallback): void {
    if (this.#tail.length) this.push(this.#tail);
    cb();
  }
  #mask(buf: Buffer): Buffer {
    for (const n of this.#needles) {
      for (let i = buf.indexOf(n); i >= 0; i = buf.indexOf(n, i + n.length))
        buf.fill(0x2a, i, i + n.length);
    }
    return buf;
  }
}

function maskString(s: string, needles: string[]): string {
  let out = s;
  for (const n of needles) if (n.length >= 4) out = out.split(n).join('*'.repeat(n.length));
  return out;
}

interface Target {
  host: string;
  port: number;
  address: string;
  cls: AddressClass;
  devServer: boolean;
}

interface Decision {
  action: 'egress.request' | 'egress.connect';
  method: string | null;
  host: string;
  port: number;
  allow: boolean;
  cause: EgressBlockCause | null;
  rule: string | null;
  cls: AddressClass | null;
  status: number | null;
  inspected: boolean;
  bytesIn: number;
  bytesOut: number;
  credentials?: string[];
  hooks?: string[];
  error?: string;
}

class Session implements LocalEgressSession {
  readonly id = uuidv7();
  readonly accountId: string;
  readonly scope: EgressScope;
  readonly policy: ProxyPolicy;
  readonly dir: string;
  readonly socketName = 'proxy.sock';
  readonly caBundleName: string | null;
  readonly caCertPem: string | null;
  readonly token = randomBytes(18).toString('base64url');
  proxyUrl = '';
  readonly servers: NetServer[] = [];
  readonly sockets = new Set<Socket>();
  /** Sockets of the loopback listener, which must present the token. */
  readonly needsAuth = new WeakSet<Socket>();
  readonly targets = new WeakMap<Socket, Target>();
  readonly http: HttpServer;
  readonly inner: HttpServer;
  closed = false;
  #close: (s: Session) => Promise<void>;

  constructor(input: {
    accountId: string;
    scope: EgressScope;
    policy: ProxyPolicy;
    dir: string;
    caCertPem: string | null;
    caBundleName: string | null;
    http: HttpServer;
    inner: HttpServer;
    close: (s: Session) => Promise<void>;
  }) {
    this.accountId = input.accountId;
    this.scope = input.scope;
    this.policy = input.policy;
    this.dir = input.dir;
    this.caCertPem = input.caCertPem;
    this.caBundleName = input.caBundleName;
    this.http = input.http;
    this.inner = input.inner;
    this.#close = input.close;
  }

  close(): Promise<void> {
    return this.#close(this);
  }
}

export class EgressProxyService implements EgressProxy {
  readonly #o: EgressProxyOptions;
  readonly #base: string;
  readonly #sessions = new Set<Session>();
  readonly #grants = new Map<string, Set<string>>();
  readonly #resolve: (host: string) => Promise<string[]>;
  readonly #classify: (address: string) => AddressClass;

  constructor(opts: EgressProxyOptions = {}) {
    this.#o = opts;
    this.#base =
      opts.socketDir ??
      join(
        tmpdir().length < 60 ? tmpdir() : '/tmp',
        `nova-egress-${randomBytes(6).toString('hex')}`,
      );
    this.#resolve =
      opts.resolve ??
      (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.#classify = opts.classify ?? classifyAddress;
  }

  /** Whether HTTPS can be inspected (the per-Hub CA is loaded). */
  get inspects(): boolean {
    return !!this.#o.ca;
  }

  get caCertPem(): string | null {
    return this.#o.ca?.certPem ?? null;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Allow a dev server on a private address for one scope (docs/12 §4.2); effective only when the
   * scope's policy also sets `allowLocalBinding`. Returns the revoke function.
   */
  grantDevServer(input: {
    accountId: string;
    scope: EgressScope;
    host: string;
    port: number;
  }): () => void {
    const key = `${input.accountId}|${input.scope.kind}|${input.scope.id}`;
    const set = this.#grants.get(key) ?? new Set<string>();
    const entry = `${normalizeHost(input.host)}:${input.port}`;
    set.add(entry);
    this.#grants.set(key, set);
    return () => {
      set.delete(entry);
      if (!set.size) this.#grants.delete(key);
    };
  }

  async open(input: {
    accountId: string;
    scope: EgressScope;
    policy: ProxyPolicy;
  }): Promise<LocalEgressSession> {
    // A bare `*` or a misplaced wildcard is rejected as the policy loads (FR-193).
    const policy: ProxyPolicy = {
      ...validateEgressPolicy(input.policy),
      hooks: [...(input.policy.hooks ?? [])],
    };
    const shared = this.#o.socketAccess === 'everyone';
    const dirMode = shared ? 0o711 : 0o700;
    mkdirSync(this.#base, { recursive: true, mode: dirMode });
    chmodSync(this.#base, dirMode);
    const dir = join(this.#base, randomBytes(8).toString('hex'));
    mkdirSync(dir, { mode: dirMode });
    chmodSync(dir, dirMode);
    const ca = this.#o.ca ?? null;
    let caBundleName: string | null = null;
    if (ca) {
      caBundleName = 'ca-bundle.pem';
      writeFileSync(join(dir, caBundleName), ca.bundlePem(), { mode: 0o644 });
      writeFileSync(join(dir, 'ca.pem'), ca.certPem, { mode: 0o644 });
    }
    const http = createHttpServer();
    const inner = createHttpServer();
    const session = new Session({
      accountId: input.accountId,
      scope: input.scope,
      policy,
      dir,
      caCertPem: ca?.certPem ?? null,
      caBundleName,
      http,
      inner,
      close: (s) => this.#closeSession(s),
    });
    const idle = this.#o.idleTimeoutMs ?? 600_000;
    for (const server of [http, inner]) {
      server.timeout = idle;
      server.keepAliveTimeout = 5_000;
      server.on('clientError', (_err, socket) => socket.destroy());
    }
    http.on('request', (req, res) => {
      this.#onRequest(session, req, res, false).catch((err: unknown) => this.#fail(res, err));
    });
    http.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      this.#onConnect(session, req, socket, head).catch(() => socket.destroy());
    });
    inner.on('request', (req, res) => {
      this.#onRequest(session, req, res, true).catch((err: unknown) => this.#fail(res, err));
    });
    const accept = (auth: boolean) => (socket: Socket) => {
      if (session.closed) {
        socket.destroy();
        return;
      }
      session.sockets.add(socket);
      socket.on('close', () => session.sockets.delete(socket));
      socket.on('error', () => undefined);
      if (auth) session.needsAuth.add(socket);
      http.emit('connection', socket);
    };
    const unix = createNetServer(accept(false));
    const tcp = createNetServer(accept(true));
    session.servers.push(unix, tcp);
    const socketPath = join(dir, session.socketName);
    try {
      if (Buffer.byteLength(socketPath) > 100)
        throw new NovaError('server_error', `the proxy socket path is too long: ${socketPath}`);
      await new Promise<void>((resolve, reject) => {
        unix.once('error', reject);
        unix.listen(socketPath, () => resolve());
      });
      chmodSync(socketPath, shared ? 0o666 : 0o600);
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(0, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      // Nothing is left behind by a session that could not start.
      await this.#closeSession(session);
      throw err;
    }
    const addr = tcp.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    session.proxyUrl = `http://nova:${session.token}@127.0.0.1:${port}`;
    this.#sessions.add(session);
    return session;
  }

  /** Close every session (Hub shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((s) => s.close()));
    rmSync(this.#base, { recursive: true, force: true });
  }

  async #closeSession(s: Session): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    this.#sessions.delete(s);
    for (const sock of s.sockets) sock.destroy();
    await Promise.all(
      s.servers.map((srv) =>
        srv.listening ? new Promise<void>((r) => srv.close(() => r())) : Promise.resolve(),
      ),
    );
    s.http.close();
    s.inner.close();
    if (existsSync(s.dir)) rmSync(s.dir, { recursive: true, force: true });
  }

  // ---- requests -------------------------------------------------------------------------------

  #authorized(s: Session, req: IncomingMessage): boolean {
    if (!s.needsAuth.has(req.socket)) return true;
    const h = req.headers['proxy-authorization'];
    const m = typeof h === 'string' ? /^Basic\s+(.+)$/i.exec(h) : null;
    if (!m?.[1]) return false;
    const given = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8'));
    const want = Buffer.from(`nova:${s.token}`);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  #grantedDevServer(s: Session, host: string, port: number): boolean {
    const key = `${s.accountId}|${s.scope.kind}|${s.scope.id}`;
    if (this.#grants.get(key)?.has(`${normalizeHost(host)}:${port}`)) return true;
    try {
      return (
        this.#o.devServerGrant?.({ accountId: s.accountId, scope: s.scope, host, port }) ?? false
      );
    } catch {
      return false;
    }
  }

  async #credentialsFor(s: Session, host: string): Promise<EgressCredential[]> {
    if (!s.policy.credentials.length || !this.#o.credentials) return [];
    try {
      const all = await this.#o.credentials(s.accountId, s.policy.credentials);
      return all.filter((c) => matchingPattern(c.hosts, host));
    } catch (err) {
      // A vault failure means no credential: the request goes out without one (fail closed).
      this.#o.log?.warn('egress credentials unavailable', { err });
      return [];
    }
  }

  #hooksFor(s: Session, host: string, method: string | null, path: string | null): EgressHook[] {
    return (s.policy.hooks ?? []).filter(
      (h) =>
        matchingPattern([h.host], host) &&
        (method === null ||
          !h.methods?.length ||
          h.methods.some((m) => m.toUpperCase() === method.toUpperCase())) &&
        (path === null || !h.pathPrefix || path.startsWith(h.pathPrefix)),
    );
  }

  /** Resolve and classify; null address when the destination is not allowed (private). */
  async #pin(
    s: Session,
    host: string,
    devServer: boolean,
  ): Promise<{ address: string | null; cls: AddressClass }> {
    const h = normalizeHost(host);
    const addresses = isIP(h) ? [h] : await this.#resolve(h);
    if (!addresses.length) throw new NovaError('network', `${host} did not resolve`);
    const classes = addresses.map((a) => this.#classify(a));
    // Any non-public answer blocks the name (a rebinding answer cannot sneak through).
    const bad = classes.find((c) => c !== 'public');
    if (bad && !addressAllowed(s.policy, bad, devServer)) return { address: null, cls: bad };
    return { address: addresses[0] ?? null, cls: classes[0] ?? 'reserved' };
  }

  async #onRequest(
    s: Session,
    req: IncomingMessage,
    res: ServerResponse,
    inspected: boolean,
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let host: string;
    let port: number;
    let path: string;
    let target: Target | undefined;
    if (inspected) {
      target = s.targets.get(req.socket);
      if (!target) {
        res.destroy();
        return;
      }
      ({ host, port } = target);
      path = req.url ?? '/';
      // The Host header must name the host the tunnel was opened to (no fronting).
      const named = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (named && normalizeHost(named) !== normalizeHost(host)) {
        await this.#block(s, res, {
          action: 'egress.request',
          method,
          host,
          port,
          cause: 'policy',
          rule: 'host-mismatch',
          cls: target.cls,
          inspected,
        });
        return;
      }
    } else {
      if (!this.#authorized(s, req)) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="nova-egress"' }).end();
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '');
      } catch {
        res
          .writeHead(400, { 'content-type': 'text/plain' })
          .end('This is the Nova egress proxy.\n');
        return;
      }
      if (url.protocol !== 'http:') {
        res
          .writeHead(400, { 'content-type': 'text/plain' })
          .end('Use CONNECT for HTTPS through the Nova egress proxy.\n');
        return;
      }
      host = normalizeHost(url.hostname);
      port = url.port ? Number(url.port) : 80;
      path = `${url.pathname}${url.search}`;
    }
    const devServer = this.#grantedDevServer(s, host, port);
    const d = decideHost(s.policy, { host, port, method, devServer });
    const base = { action: 'egress.request' as const, method, host, port, inspected };
    if (!d.allow) {
      await this.#block(s, res, {
        ...base,
        cause: d.cause ?? 'policy',
        rule: d.rule,
        cls: target?.cls ?? null,
      });
      return;
    }
    const hooks = this.#hooksFor(s, host, method, path);
    const blocking = hooks.find((h) => h.action === 'block');
    if (blocking) {
      await this.#block(s, res, {
        ...base,
        cause: 'policy',
        rule: `hook:${blocking.id}`,
        cls: target?.cls ?? null,
      });
      return;
    }
    let address: string;
    let cls: AddressClass;
    if (target) {
      address = target.address;
      cls = target.cls;
    } else {
      let pinned: { address: string | null; cls: AddressClass };
      try {
        pinned = await this.#pin(s, host, d.devServer || devServer);
      } catch (err) {
        await this.#upstreamError(s, res, { ...base, rule: d.rule, cls: null }, err);
        return;
      }
      if (!pinned.address) {
        await this.#block(s, res, {
          ...base,
          cause: 'private_address',
          rule: d.rule,
          cls: pinned.cls,
        });
        return;
      }
      address = pinned.address;
      cls = pinned.cls;
    }

    const headers = this.#forwardHeaders(req.headers, hooks);
    headers.host = port === (inspected ? 443 : 80) ? host : `${host}:${port}`;
    const creds = await this.#credentialsFor(s, host);
    const needles: string[] = [];
    const used: string[] = [];
    for (const c of creds) {
      const v = await c.value().catch(() => null);
      if (!v) continue;
      used.push(c.id);
      needles.push(v);
      if (c.scheme === 'bearer') {
        headers.authorization = `Bearer ${v}`;
      } else if (c.scheme === 'basic') {
        const b64 = Buffer.from(`${c.username ?? ''}:${v}`).toString('base64');
        needles.push(b64);
        headers.authorization = `Basic ${b64}`;
      } else if (c.header) {
        headers[c.header.toLowerCase()] = v;
      }
    }
    // An identity body can be scanned for the injected value before it reaches the sandbox.
    if (used.length) headers['accept-encoding'] = 'identity';

    let bytesOut = 0;
    let bytesIn = 0;
    const upstream = (inspected ? httpsRequest : httpRequest)({
      host: address,
      port,
      method,
      path,
      headers,
      agent: false,
      timeout: this.#o.connectTimeoutMs ?? 30_000,
      ...(inspected
        ? {
            servername: isIP(host) ? undefined : host,
            ...(this.#o.upstreamCa?.length
              ? { ca: [...rootCertificates, ...this.#o.upstreamCa] }
              : {}),
          }
        : {}),
    });
    const done = new Promise<void>((resolve) => {
      let responded = false;
      let status: number | null = null;
      let error: string | undefined;
      const finish = () => {
        const rec: Decision = {
          ...base,
          allow: true,
          cause: null,
          rule: d.rule,
          cls,
          status,
          bytesIn,
          bytesOut,
          credentials: used,
          hooks: hooks.map((h) => h.id),
        };
        if (error) rec.error = error;
        void this.#audit(s, rec).finally(resolve);
      };
      upstream.on('response', (up) => {
        responded = true;
        status = up.statusCode ?? 502;
        const out: OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || STRIP_RESPONSE.has(k)) continue;
          out[k] = Array.isArray(v) ? v.map((x) => maskString(x, needles)) : maskString(v, needles);
        }
        res.writeHead(status, up.statusMessage ?? '', out);
        up.on('data', (c: Buffer) => (bytesIn += c.length));
        const body = needles.length ? up.pipe(new Masker(needles)) : up;
        body.pipe(res);
        res.on('close', () => {
          up.destroy();
          finish();
        });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
      upstream.on('error', (err) => {
        if (responded) {
          error = err.message;
          res.destroy();
          return;
        }
        void this.#upstreamError(s, res, { ...base, rule: d.rule, cls }, err).finally(resolve);
      });
    });
    req.on('data', (c: Buffer) => (bytesOut += c.length));
    req.pipe(upstream);
    await done;
  }

  #forwardHeaders(h: IncomingHttpHeaders, hooks: EgressHook[]): OutgoingHttpHeaders {
    const strip = new Set(STRIP_REQUEST);
    // A Connection header names more hop-by-hop headers.
    const conn = h.connection;
    if (typeof conn === 'string')
      for (const n of conn.split(',')) strip.add(n.trim().toLowerCase());
    for (const k of hooks) {
      if (k.action === 'strip_header' && k.header) strip.add(k.header.toLowerCase());
      if (k.action === 'strip_cookies') strip.add('cookie');
    }
    const out: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || strip.has(k) || k === 'host') continue;
      out[k] = v;
    }
    return out;
  }

  async #onConnect(s: Session, req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    if (!this.#authorized(s, req)) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="nova-egress"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
    if (!m?.[1] || !m[2]) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const host = normalizeHost(m[1]);
    const port = Number(m[2]);
    const base = {
      action: 'egress.connect' as const,
      method: 'CONNECT',
      host,
      port,
    };
    const devServer = this.#grantedDevServer(s, host, port);
    const d = decideHost(s.policy, { host, port, method: null, devServer });
    if (!d.allow) {
      await this.#blockRaw(s, socket, {
        ...base,
        inspected: false,
        cause: d.cause ?? 'policy',
        rule: d.rule,
        cls: null,
      });
      return;
    }
    const ca = this.#o.ca ?? null;
    const creds = await this.#credentialsFor(s, host);
    const hooks = this.#hooksFor(s, host, null, null);
    // A hook that blocks the whole host applies even to a tunnel that is not inspected.
    const hostBlock = hooks.find(
      (h) => h.action === 'block' && !h.methods?.length && !h.pathPrefix,
    );
    if (hostBlock) {
      await this.#blockRaw(s, socket, {
        ...base,
        inspected: false,
        cause: 'policy',
        rule: `hook:${hostBlock.id}`,
        cls: null,
      });
      return;
    }
    const wantsInspection = s.policy.mode === 'limited' || creds.length > 0 || hooks.length > 0;
    if (wantsInspection && !ca && s.policy.mode === 'limited') {
      await this.#blockRaw(s, socket, {
        ...base,
        inspected: false,
        cause: 'inspection',
        rule: d.rule,
        cls: null,
      });
      return;
    }
    let pinned: { address: string | null; cls: AddressClass };
    try {
      pinned = await this.#pin(s, host, d.devServer || devServer);
    } catch (err) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      await this.#audit(s, {
        ...base,
        allow: true,
        cause: null,
        rule: d.rule,
        cls: null,
        status: 502,
        inspected: false,
        bytesIn: 0,
        bytesOut: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!pinned.address) {
      await this.#blockRaw(s, socket, {
        ...base,
        inspected: false,
        cause: 'private_address',
        rule: d.rule,
        cls: pinned.cls,
      });
      return;
    }
    const target: Target = {
      host,
      port,
      address: pinned.address,
      cls: pinned.cls,
      devServer: d.devServer || devServer,
    };
    if (wantsInspection && ca) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      const tls = new TLSSocket(socket, {
        isServer: true,
        secureContext: ca.leaf(host).context,
        ALPNProtocols: ['http/1.1'],
      });
      s.targets.set(tls, target);
      tls.on('error', (err: Error) => {
        void this.#audit(s, {
          ...base,
          allow: true,
          cause: null,
          rule: d.rule,
          cls: target.cls,
          status: null,
          inspected: true,
          bytesIn: 0,
          bytesOut: 0,
          error: `tls: ${err.message}`,
        }).catch(() => undefined);
        tls.destroy();
      });
      s.inner.emit('connection', tls);
      return;
    }
    // An opaque tunnel to the pinned address; credentials need inspection, so none are added.
    await this.#tunnel(s, socket, head, target, {
      ...base,
      rule: d.rule,
      credentialsSkipped: creds.length > 0,
    });
  }

  #tunnel(
    s: Session,
    socket: Socket,
    head: Buffer,
    t: Target,
    base: {
      action: 'egress.connect';
      method: string;
      host: string;
      port: number;
      rule: string | null;
      credentialsSkipped: boolean;
    },
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let bytesIn = 0;
      let bytesOut = head.length;
      let connected = false;
      const up = netConnect({ host: t.address, port: t.port });
      s.sockets.add(up);
      up.setTimeout(this.#o.connectTimeoutMs ?? 30_000, () => up.destroy(new Error('timed out')));
      const finish = (error?: string) => {
        s.sockets.delete(up);
        const rec: Decision = {
          action: base.action,
          method: base.method,
          host: base.host,
          port: base.port,
          allow: true,
          cause: null,
          rule: base.rule,
          cls: t.cls,
          status: connected ? 200 : 502,
          inspected: false,
          bytesIn,
          bytesOut,
        };
        if (error) rec.error = error;
        if (base.credentialsSkipped) rec.error = 'credentials need inspection; none were added';
        void this.#audit(s, rec)
          .catch(() => undefined)
          .finally(resolve);
      };
      up.once('connect', () => {
        connected = true;
        up.setTimeout(this.#o.idleTimeoutMs ?? 600_000, () => up.destroy());
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        socket.on('data', (c: Buffer) => (bytesOut += c.length));
        up.on('data', (c: Buffer) => (bytesIn += c.length));
        socket.pipe(up);
        up.pipe(socket);
      });
      let ended = false;
      const end = (error?: string) => {
        if (ended) return;
        ended = true;
        socket.destroy();
        up.destroy();
        finish(error);
      };
      up.on('error', (err) => {
        if (!connected)
          socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        end(err.message);
      });
      up.on('close', () => end());
      socket.on('close', () => end());
    });
  }

  async #block(
    s: Session,
    res: ServerResponse,
    d: Omit<Decision, 'allow' | 'status' | 'bytesIn' | 'bytesOut' | 'cause'> & {
      cause: EgressBlockCause;
    },
  ): Promise<void> {
    const body = blockBody(d.host, d.cause);
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'x-nova-block-cause': d.cause,
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    await this.#audit(s, { ...d, allow: false, status: 403, bytesIn: 0, bytesOut: 0 });
  }

  async #blockRaw(
    s: Session,
    socket: Socket,
    d: Omit<Decision, 'allow' | 'status' | 'bytesIn' | 'bytesOut' | 'cause'> & {
      cause: EgressBlockCause;
    },
  ): Promise<void> {
    const body = blockBody(d.host, d.cause);
    socket.end(
      `HTTP/1.1 403 Forbidden\r\nX-Nova-Block-Cause: ${d.cause}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    await this.#audit(s, { ...d, allow: false, status: 403, bytesIn: 0, bytesOut: 0 });
  }

  async #upstreamError(
    s: Session,
    res: ServerResponse,
    d: Pick<Decision, 'action' | 'method' | 'host' | 'port' | 'inspected' | 'rule' | 'cls'>,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res
        .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`Nova could not reach ${d.host}: ${message}\n`);
    } else res.destroy();
    await this.#audit(s, {
      ...d,
      allow: true,
      cause: null,
      status: 502,
      bytesIn: 0,
      bytesOut: 0,
      error: message,
    });
  }

  #fail(res: ServerResponse, err: unknown): void {
    this.#o.log?.warn('egress proxy request failed', { err });
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  }

  async #audit(s: Session, d: Decision): Promise<void> {
    if (!this.#o.audit) return;
    const detail: Record<string, unknown> = {
      egressSession: s.id,
      scope: { kind: s.scope.kind, id: s.scope.id },
      method: d.method,
      host: d.host,
      port: d.port,
      addressClass: d.cls,
      mode: s.policy.mode,
      decision: d.allow ? 'allow' : 'deny',
      cause: d.cause,
      rule: d.rule,
      status: d.status,
      inspected: d.inspected,
      bytesIn: d.bytesIn,
      bytesOut: d.bytesOut,
    };
    if (d.credentials?.length) detail.credentials = d.credentials;
    if (d.hooks?.length) detail.hooks = d.hooks;
    if (d.error) detail.error = d.error.slice(0, 300);
    try {
      await this.#o.audit.append({
        accountId: s.accountId,
        actor: s.scope.kind === 'agent' ? `agent:${s.scope.id}` : 'system',
        kind: 'network',
        action: d.action,
        resource: `${d.host}:${d.port}`,
        inputHash: createHash('sha256')
          .update(`${d.method ?? ''} ${d.host}:${d.port}`)
          .digest('hex'),
        decision: d.allow ? 'allow' : 'deny',
        result: d.allow ? (d.status === null ? 'error' : String(d.status)) : (d.cause ?? 'policy'),
        detail,
      });
    } catch (err) {
      this.#o.log?.warn('egress audit failed', { err });
    }
  }
}
