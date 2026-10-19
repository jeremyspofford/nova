// The self-hostable Relay (FR-137, docs/22 §3, contracts/rest-api.md §3). Content-blind: it sees
// routing ids, frame kinds, sequence numbers and sizes, never content, and stores nothing beyond
// routing registrations and a bounded queue of ciphertext awaiting delivery. Hubs and clients
// connect out to it; it forwards sealed envelopes between a Hub and its confirmed client routes.
// A pending (claimed, unconfirmed) route gets only the Hub's data frames on Hub-opened streams
// (the Hub's sealed `decided` notice, M7) and sends nothing until the Hub confirms it.
//
// Authentication: a Hub registers (optionally gated by a registration token) and gets a route
// token; a client gets its route token by claiming a pairing slot with the code's hash; every
// later call and the WebSocket present a route token (bearer header, or the `bearer.<token>`
// subprotocol for browsers). Route tokens are stored hashed and authorize nothing on the Hub.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import {
  CLOSE_CODES,
  MAX_FRAME_BYTES,
  RELAY_SUBPROTOCOL,
  ROUTE_ID,
  encodeEnvelope,
  parseEnvelope,
  type RelayCloseReason,
  type RelayEnvelope,
} from '@nova/relay';
import { streamLog, type RelayLog } from './log.ts';
import { isIP } from 'node:net';
import {
  MockPushSender,
  PUSH_TOPIC,
  pushTokenProblem,
  type PushOutcome,
  type PushSender,
} from './push.ts';
import { DeliveryQueue } from './queue.ts';
import {
  RelayState,
  newId,
  newRouteToken,
  sameSecret,
  tokenHash,
  type ClientRoute,
  type HubRecord,
  type Pairing,
} from './state.ts';

export interface RelayLimits {
  /** Frames above this are refused with `close {reason: too_large}`. */
  maxFrameBytes: number;
  /** Connections per route; a new one beyond it replaces the oldest. */
  maxConnectionsPerRoute: number;
  /** The delivery queue per offline route: frames, bytes and age. */
  queueMaxFrames: number;
  queueMaxBytes: number;
  queueMaxAgeMs: number;
  /** Queued bytes for one Hub and its clients together. */
  hubQueueMaxBytes: number;
  /** Queued bytes in total; past it the oldest frames anywhere go first. */
  queueMaxTotalBytes: number;
  /** Client routes (pending or active) one Hub may have. */
  maxRoutesPerHub: number;
  /** Hubs and client routes in total, and open connections. */
  maxHubs: number;
  maxRoutes: number;
  maxConnections: number;
  /** A Hub without client routes that has not connected for this long is forgotten. */
  hubUnusedTtlMs: number;
  /** Any Hub not seen for this long is forgotten with its client routes. */
  hubIdleTtlMs: number;
  /** A connection that sends nothing for this long is closed with `idle`. */
  idleTimeoutMs: number;
  /** The longest pairing slot (docs/22 §4: 5 minutes). */
  pairingTtlMs: number;
  /** A claimed route waits this long for the Hub's confirmation. */
  pendingRouteTtlMs: number;
  maxOpenPairingsPerHub: number;
  /** Wrong codes before a pairing slot is burned. */
  claimAttempts: number;
  registrationsPerHour: number;
  claimsPerMinute: number;
  /** At most one push wake-up per route per this interval. */
  pushIntervalMs: number;
  /** Notifications the Hub may push to one route per minute (FR-111). */
  notifyPerRouteMinute: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxFrameBytes: MAX_FRAME_BYTES,
  maxConnectionsPerRoute: 2,
  queueMaxFrames: 512,
  queueMaxBytes: 8 * 1024 * 1024,
  queueMaxAgeMs: 120_000,
  hubQueueMaxBytes: 32 * 1024 * 1024,
  queueMaxTotalBytes: 256 * 1024 * 1024,
  maxRoutesPerHub: 100,
  maxHubs: 10_000,
  maxRoutes: 100_000,
  maxConnections: 20_000,
  hubUnusedTtlMs: 24 * 60 * 60_000,
  hubIdleTtlMs: 30 * 24 * 60 * 60_000,
  idleTimeoutMs: 90_000,
  pairingTtlMs: 5 * 60_000,
  pendingRouteTtlMs: 15 * 60_000,
  maxOpenPairingsPerHub: 20,
  claimAttempts: 5,
  registrationsPerHour: 20,
  claimsPerMinute: 30,
  pushIntervalMs: 30_000,
  notifyPerRouteMinute: 30,
};

export interface RelayServerOptions {
  /** Persist routing registrations here (JSON, 0600); memory only without it. */
  dataDir?: string | null;
  state?: RelayState;
  log?: RelayLog;
  push?: PushSender;
  limits?: Partial<RelayLimits>;
  /** When set, `POST /v1/relay/hubs` needs it as a bearer token (a private Relay). */
  registrationToken?: string | null;
  now?: () => number;
  version?: string;
  /**
   * Behind a reverse proxy: how many proxy hops to trust (a number) or the proxies' addresses or
   * CIDR ranges. Never `true`: a client could then pick its own address in X-Forwarded-For and
   * slip past the per-address limits.
   */
  trustProxy?: false | number | string | string[];
  /** How often expiry runs (default 5 s). */
  sweepIntervalMs?: number;
  /** Registration changes within this interval share one write (default 1 s). */
  saveDebounceMs?: number;
}

export interface RelayStats {
  connections: number;
  forwarded: number;
  queued: number;
  /** Bytes waiting in the delivery queue now. */
  queuedBytes: number;
  evicted: number;
  invalid: number;
  unknownRoute: number;
  pushes: number;
}

export interface RelayServer {
  app: FastifyInstance;
  state: RelayState;
  push: PushSender;
  stats(): RelayStats;
  /** Frames waiting for a route. */
  queued(routeId: string): number;
  /** Run expiry now (it also runs every `sweepIntervalMs`). */
  sweep(): void;
  close(): Promise<void>;
}

interface Conn {
  routeId: string;
  kind: 'hub' | 'client';
  ws: WebSocket;
  idle: ReturnType<typeof setTimeout> | null;
  /** Counted in the open connections until its socket closes. */
  counted: boolean;
}

/** Check a `trustProxy` setting: a hop count, or proxy addresses or CIDR ranges. */
export function parseTrustProxy(value: unknown): false | number | string[] {
  if (value === undefined || value === null || value === false) return false;
  if (value === true)
    throw new Error('trustProxy must be a hop count or the proxy addresses, not true');
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 10)
      throw new Error('trustProxy hops must be 1..10');
    return value;
  }
  if (typeof value !== 'string' && !Array.isArray(value))
    throw new Error('trustProxy must be a hop count or the proxy addresses');
  const list = (Array.isArray(value) ? (value as unknown[]) : value.split(','))
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  if (list.length === 1 && /^\d+$/.test(list[0]!)) return parseTrustProxy(Number(list[0]));
  if (!list.length) throw new Error('trustProxy needs at least one address');
  for (const entry of list) {
    const [addr, bits, ...rest] = entry.split('/');
    const family = isIP(addr ?? '');
    const max = family === 6 ? 128 : 32;
    if (
      !family ||
      rest.length ||
      (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))
    )
      throw new Error(`trustProxy: not an address or CIDR range: ${entry}`);
  }
  return list;
}

const PAIRING_ID = /^[A-Za-z0-9_-]{16,32}$/;
const CODE_HASH = /^[A-Za-z0-9_-]{43}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64 = (max: number) => z.string().min(4).max(max).regex(BASE64, 'base64');

const pairingBody = z
  .object({
    id: z.string().regex(PAIRING_ID).optional(),
    codeHash: z.string().regex(CODE_HASH),
    expiresAt: z.iso.datetime({ offset: true }),
    offer: base64(8192),
  })
  .strict();
const claimBody = z.object({ codeHash: z.string().regex(CODE_HASH), blob: base64(16384) }).strict();
// Token shapes are checked here (M7): a malformed token is refused instead of failing later.
const pushBody = z
  .object({
    platform: z.enum(['apns', 'fcm']),
    token: z.string().min(1).max(4096),
    topic: z.string().regex(PUSH_TOPIC, 'a bundle id').optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const problem = pushTokenProblem(v.platform, v.token);
    if (problem) ctx.addIssue({ code: 'custom', path: ['token'], message: problem });
    if (v.topic && v.platform !== 'apns')
      ctx.addIssue({ code: 'custom', path: ['topic'], message: 'only APNs takes a topic' });
  });
/**
 * POST /v1/relay/push/notify (the Hub): ids, a redacted title and a deep link, nothing else. The
 * shapes are narrow on purpose so a Hub cannot route content through push (docs/13 §6).
 */
const notifyBody = z
  .object({
    routes: z.array(z.string().regex(ROUTE_ID)).min(1).max(50),
    notification: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        category: z.enum(['approval', 'completion', 'error', 'attention', 'system']),
        title: z.string().min(1).max(80),
        link: z
          .string()
          .regex(/^nova:\/\/(run|code|approval|chat)\/[A-Za-z0-9-]{1,64}$/)
          .nullable(),
      })
      .strict(),
  })
  .strict();
const idParam = z.object({ id: z.string().regex(PAIRING_ID) });
const routeParam = z.object({ routeId: z.string().regex(ROUTE_ID) });

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A sliding-window counter per key (an address). */
class Limiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }
  take(key: string, now: number): boolean {
    const list = (this.#hits.get(key) ?? []).filter((t) => t > now - this.#windowMs);
    if (list.length >= this.#limit) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    return true;
  }
  sweep(now: number): void {
    for (const [k, list] of this.#hits) {
      const kept = list.filter((t) => t > now - this.#windowMs);
      if (kept.length) this.#hits.set(k, kept);
      else this.#hits.delete(k);
    }
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

/** The route token of a WebSocket upgrade: a bearer header, or the `bearer.<token>` subprotocol. */
function upgradeToken(req: FastifyRequest): string | null {
  const b = bearer(req);
  if (b) return b;
  const protocols = req.headers['sec-websocket-protocol'];
  if (typeof protocols !== 'string') return null;
  for (const p of protocols.split(',')) {
    const t = p.trim();
    if (t.startsWith('bearer.')) return t.slice(7);
  }
  return null;
}

export async function buildRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => Date.now());
  const iso = (t = now()) => new Date(t).toISOString();
  const log = opts.log ?? streamLog();
  const trustProxy = parseTrustProxy(opts.trustProxy);
  const state =
    opts.state ??
    new RelayState({
      dataDir: opts.dataDir ?? null,
      ...(opts.saveDebounceMs !== undefined ? { saveDebounceMs: opts.saveDebounceMs } : {}),
    });
  state.onWriteError = (err) => log.error('the Relay state was not written', { err });
  const push = opts.push ?? new MockPushSender();
  const conns = new Map<string, Conn[]>();
  let connections = 0;
  const queue = new DeliveryQueue(
    {
      routeMaxFrames: limits.queueMaxFrames,
      routeMaxBytes: limits.queueMaxBytes,
      hubMaxBytes: limits.hubQueueMaxBytes,
      totalMaxBytes: limits.queueMaxTotalBytes,
      maxAgeMs: limits.queueMaxAgeMs,
    },
    now,
  );
  const lastPush = new Map<string, number>();
  const registrations = new Limiter(limits.registrationsPerHour, 60 * 60_000);
  const claims = new Limiter(limits.claimsPerMinute, 60_000);
  const stats: Omit<RelayStats, 'connections' | 'evicted' | 'queuedBytes'> = {
    forwarded: 0,
    queued: 0,
    invalid: 0,
    unknownRoute: 0,
    pushes: 0,
  };

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    // A hop count trusts that many proxies in front (counted from this server); a list trusts
    // exactly those addresses. The client's own X-Forwarded-For entries are never believed.
    trustProxy:
      typeof trustProxy === 'number'
        ? (_addr: string, hop: number) => hop < trustProxy
        : trustProxy,
  });
  await app.register(fastifyWebsocket, {
    options: {
      // Larger than any valid frame, so an oversized one gets a `too_large` close frame first.
      maxPayload: Math.max(limits.maxFrameBytes * 4, 1024 * 1024),
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false,
    },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          retryable: err.status === 429 || err.status >= 500,
          ...(err.details ? { details: err.details } : {}),
        },
        requestId: req.id,
      });
      return;
    }
    if (err instanceof z.ZodError) {
      void reply.status(400).send({
        error: {
          code: 'validation',
          message: 'request failed validation',
          retryable: false,
          details: {
            issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        },
        requestId: req.id,
      });
      return;
    }
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) log.error('relay request failed', { err });
    void reply.status(status).send({
      error: {
        code: status === 404 ? 'not_found' : status < 500 ? 'validation' : 'server_error',
        message: status < 500 && err instanceof Error ? err.message : 'internal error',
        retryable: status >= 500,
      },
      requestId: req.id,
    });
  });

  // ---- authentication ----------------------------------------------------------------------
  const hubOf = (req: FastifyRequest): HubRecord => {
    const token = bearer(req);
    const p = token ? state.principal(token) : null;
    if (p?.kind !== 'hub')
      throw new HttpError(401, 'auth_missing', 'a Hub route token is required');
    state.touch(p.hub, iso());
    return p.hub;
  };
  const clientOf = (req: FastifyRequest): ClientRoute => {
    const token = bearer(req);
    const p = token ? state.principal(token) : null;
    if (p?.kind !== 'client' || p.route.status !== 'active')
      throw new HttpError(401, 'auth_missing', 'a client route token is required');
    return p.route;
  };

  // ---- delivery ------------------------------------------------------------------------------
  const newest = (routeId: string): Conn | null => {
    const list = conns.get(routeId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.ws.readyState === 1) return list[i]!;
    return null;
  };

  const closeFrame = (to: string, from: string, reason: RelayCloseReason): string =>
    encodeEnvelope({ v: 1, kind: 'close', to, from, reason });

  const end = (conn: Conn, reason: RelayCloseReason): void => {
    try {
      conn.ws.send(closeFrame(conn.routeId, conn.routeId, reason));
    } catch {
      // the socket is going away anyway
    }
    conn.ws.close(CLOSE_CODES[reason], reason);
  };

  /** The Hub a route belongs to (a Hub's own route is its own). */
  const hubOfRoute = (routeId: string): string => state.routes.get(routeId)?.hubRouteId ?? routeId;

  const flushQueue = (conn: Conn): void => {
    for (const text of queue.take(conn.routeId)) conn.ws.send(text);
  };

  const wake = (route: ClientRoute): void => {
    const reg = route.push;
    if (!reg) return;
    const t = now();
    if ((lastPush.get(route.routeId) ?? -Infinity) > t - limits.pushIntervalMs) return;
    lastPush.set(route.routeId, t);
    stats.pushes++;
    push
      .send({
        platform: reg.platform,
        token: reg.token,
        topic: reg.topic,
        kind: 'wake',
        routeId: route.routeId,
      })
      .then((out) => settlePush(route, out))
      .catch((err: unknown) => log.warn('push wake-up failed', { err, routeId: route.routeId }));
  };

  /** A token the push service no longer knows is dropped; the client registers a new one. */
  const settlePush = (route: ClientRoute, out: void | PushOutcome): boolean => {
    if (!out) return true;
    if (out.gone && route.push) {
      state.clearPush(route);
      log.info('push token dropped', { routeId: route.routeId, detail: out.detail ?? null });
    } else if (!out.ok)
      log.warn('push not delivered', { routeId: route.routeId, detail: out.detail });
    return out.ok;
  };
  const notifyHits = new Limiter(limits.notifyPerRouteMinute, 60_000);

  const forward = (routeId: string, text: string, client: ClientRoute | null): void => {
    const target = newest(routeId);
    if (target) {
      target.ws.send(text);
      stats.forwarded++;
      return;
    }
    // Bounded per route, per Hub and in total; the oldest go first (the sender retransmits).
    queue.push(routeId, hubOfRoute(routeId), text);
    stats.queued++;
    if (client) wake(client);
  };

  const unknownRoute = (conn: Conn, env: RelayEnvelope): void => {
    stats.unknownRoute++;
    conn.ws.send(closeFrame(conn.routeId, env.to, 'unknown_route'));
  };

  const route = (conn: Conn, env: RelayEnvelope): void => {
    const text = encodeEnvelope(env);
    if (conn.kind === 'hub') {
      const hub = state.hubs.get(conn.routeId);
      if (hub) state.touch(hub, iso());
      const target = state.routes.get(env.to);
      if (!target || target.hubRouteId !== conn.routeId || env.client !== target.clientId) {
        unknownRoute(conn, env);
        return;
      }
      // Nothing reaches a client before the Hub confirmed its pairing, except the Hub's own
      // sealed notices on Hub-opened streams: a denied or expired client learns which (M7).
      const notice = env.kind === 'data' && env.stream?.startsWith('h') === true;
      if (target.status !== 'active' && !(target.status === 'pending' && notice)) return;
      forward(target.routeId, text, target);
      return;
    }
    const own = state.routes.get(conn.routeId);
    if (!own || own.status !== 'active') return;
    if (env.to !== own.hubRouteId || env.client !== own.clientId) {
      unknownRoute(conn, env);
      return;
    }
    state.touch(own, iso());
    forward(own.hubRouteId, text, null);
  };

  const armIdle = (conn: Conn): void => {
    if (conn.idle) clearTimeout(conn.idle);
    conn.idle = setTimeout(() => end(conn, 'idle'), limits.idleTimeoutMs);
    conn.idle.unref?.();
  };

  const deliverClaims = (hubRouteId: string): void => {
    for (const p of state.pairings.values()) {
      if (p.hubRouteId === hubRouteId && p.status === 'claimed' && p.claim) forwardClaim(p);
    }
  };

  /**
   * The claim reaches the Hub as a data frame on the pairing's stream; the blob is opaque here.
   * It is not queued: a Hub that is offline gets every unconfirmed claim when it connects.
   */
  const forwardClaim = (p: Pairing): void => {
    const hub = newest(p.hubRouteId);
    if (!p.claim || !hub) return;
    hub.ws.send(
      encodeEnvelope({
        v: 1,
        kind: 'data',
        to: p.hubRouteId,
        from: p.claim.routeId,
        client: p.claim.clientId,
        stream: `pair.${p.id}`,
        seq: 1,
        seg: { i: 0, n: 1 },
        ct: p.claim.blob,
      }),
    );
  };

  const disconnectRoute = (routeId: string, reason: RelayCloseReason): void => {
    for (const c of conns.get(routeId) ?? []) end(c, reason);
  };

  // ---- the WebSocket -------------------------------------------------------------------------
  void app.register((scoped, _opts, done) => {
    scoped.get('/v1/relay/connect', { websocket: true }, (socket, req) => {
      const token = upgradeToken(req);
      const p = token ? state.principal(token) : null;
      if (!p || (p.kind === 'client' && !state.routes.has(p.route.routeId))) {
        socket.close(CLOSE_CODES.unauthorized, 'unauthorized');
        return;
      }
      if (p.kind === 'revoked') {
        socket.send(closeFrame(p.routeId, p.routeId, 'revoked'));
        socket.close(CLOSE_CODES.revoked, 'revoked');
        return;
      }
      if (connections >= limits.maxConnections) {
        // Full: try again later (WebSocket 1013), with the client's own backoff.
        socket.close(1013, 'busy');
        return;
      }
      const conn: Conn = {
        routeId: p.kind === 'hub' ? p.hub.routeId : p.route.routeId,
        kind: p.kind,
        ws: socket,
        idle: null,
        counted: true,
      };
      const list = conns.get(conn.routeId) ?? [];
      conns.set(conn.routeId, list);
      list.push(conn);
      connections++;
      // Per-route connection limit: the newest connection wins (a reconnect while the old
      // socket has not timed out yet).
      while (list.length > limits.maxConnectionsPerRoute) end(list.shift()!, 'normal');
      state.touch(p.kind === 'hub' ? p.hub : p.route, iso());
      armIdle(conn);
      flushQueue(conn);
      if (conn.kind === 'hub') deliverClaims(conn.routeId);

      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          stats.invalid++;
          return;
        }
        if (raw.length > limits.maxFrameBytes) {
          end(conn, 'too_large');
          return;
        }
        const check = parseEnvelope(raw.toString('utf8'), limits.maxFrameBytes);
        if (!check.ok) {
          stats.invalid++;
          return;
        }
        const env = check.envelope;
        armIdle(conn);
        // A route speaks only as itself.
        if (env.from !== conn.routeId) {
          stats.invalid++;
          return;
        }
        switch (env.kind) {
          case 'ping':
            socket.send(encodeEnvelope({ v: 1, kind: 'pong', to: env.from, from: env.to }));
            return;
          case 'pong':
          case 'close':
            return;
          case 'data':
          case 'ack':
            route(conn, env);
            return;
        }
      });
      socket.on('close', () => {
        if (conn.idle) clearTimeout(conn.idle);
        const l = conns.get(conn.routeId);
        if (conn.counted) {
          conn.counted = false;
          connections--;
        }
        if (!l) return;
        const i = l.indexOf(conn);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) conns.delete(conn.routeId);
      });
    });
    done();
  });

  // ---- HTTP ----------------------------------------------------------------------------------
  // Browsers pair and check reachability from a page the Hub serves (docs/22 §3), so the routes a
  // client calls answer cross-origin requests: any origin, never with credentials (claims and
  // pushes carry their own sealed blob or route token, and Hub routes stay same-origin only).
  const CLIENT_CORS = new Set([
    '/v1/relay/health',
    '/v1/relay/pairings/:id/claim',
    '/v1/relay/push/register',
  ]);
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin === undefined || !CLIENT_CORS.has(req.routeOptions.url ?? '')) return;
    void reply.header('Access-Control-Allow-Origin', '*');
  });
  for (const url of CLIENT_CORS)
    app.options(url, async (_req, reply) => {
      void reply
        .status(204)
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET, POST')
        .header('Access-Control-Allow-Headers', 'content-type, authorization')
        .header('Access-Control-Max-Age', '600');
      return reply.send();
    });

  app.get('/v1/relay/health', () => ({ status: 'ok', version: opts.version ?? '0.0.0' }));

  app.post('/v1/relay/hubs', async (req, reply) => {
    if (!registrations.take(req.ip, now()))
      throw new HttpError(429, 'rate_limited', 'too many registrations', { retryAfter: 3600 });
    if (opts.registrationToken) {
      const given = bearer(req) ?? '';
      if (!sameSecret(given, opts.registrationToken))
        throw new HttpError(401, 'auth_missing', 'this Relay needs a registration token');
    }
    if (state.hubs.size >= limits.maxHubs)
      throw new HttpError(503, 'relay_full', 'this Relay takes no more Hubs', { retryAfter: 3600 });
    const token = newRouteToken();
    const hub: HubRecord = {
      routeId: newId(),
      tokenHash: tokenHash(token),
      createdAt: iso(),
      lastSeenAt: null,
    };
    state.addHub(hub);
    log.info('hub registered', { routeId: hub.routeId });
    void reply.status(201);
    return Promise.resolve({ routeId: hub.routeId, routeToken: token });
  });

  app.post('/v1/relay/pairings', async (req, reply) => {
    const hub = hubOf(req);
    const body = pairingBody.parse(req.body);
    const t = now();
    const expires = Math.min(Date.parse(body.expiresAt), t + limits.pairingTtlMs);
    if (!(expires > t)) throw new HttpError(400, 'validation', 'the pairing is already expired');
    const id = body.id ?? newId();
    if (state.pairings.has(id)) throw new HttpError(409, 'conflict', 'pairing id in use');
    const open = [...state.pairings.values()].filter((p) => p.hubRouteId === hub.routeId).length;
    if (open >= limits.maxOpenPairingsPerHub)
      throw new HttpError(429, 'rate_limited', 'too many open pairings', { retryAfter: 60 });
    state.pairings.set(id, {
      id,
      hubRouteId: hub.routeId,
      codeHash: body.codeHash,
      offer: body.offer,
      expiresAt: expires,
      attempts: 0,
      status: 'open',
      claim: null,
    });
    void reply.status(201);
    return Promise.resolve({ pairingId: id, expiresAt: iso(expires) });
  });

  app.post('/v1/relay/pairings/:id/claim', async (req, reply) => {
    if (!claims.take(req.ip, now()))
      throw new HttpError(429, 'rate_limited', 'too many claims', { retryAfter: 60 });
    const { id } = idParam.parse(req.params);
    const body = claimBody.parse(req.body);
    const p = state.pairings.get(id);
    // Unknown, expired and used slots answer alike: no oracle for pairing ids.
    const gone = () =>
      new HttpError(410, 'expired', 'this pairing has expired or was already used');
    if (!p) throw gone();
    if (p.status !== 'open') throw gone();
    if (p.expiresAt <= now()) {
      state.pairings.delete(id);
      throw gone();
    }
    if (!sameSecret(body.codeHash, p.codeHash)) {
      p.attempts++;
      const left = limits.claimAttempts - p.attempts;
      if (left <= 0) state.pairings.delete(id);
      throw new HttpError(401, 'invalid_code', 'the code does not match', {
        attemptsLeft: Math.max(0, left),
      });
    }
    // Bounded routes: per Hub, and in total.
    if (state.clientRoutesOf(p.hubRouteId).length >= limits.maxRoutesPerHub)
      throw new HttpError(429, 'rate_limited', 'this Hub has too many client routes', {
        reason: 'routes_per_hub',
      });
    if (state.routes.size >= limits.maxRoutes)
      throw new HttpError(503, 'relay_full', 'this Relay takes no more clients', {
        retryAfter: 3600,
      });
    const token = newRouteToken();
    const route: ClientRoute = {
      routeId: newId(),
      clientId: newId(),
      hubRouteId: p.hubRouteId,
      tokenHash: tokenHash(token),
      status: 'pending',
      pairingId: id,
      createdAt: iso(),
      lastSeenAt: null,
      push: null,
    };
    state.addRoute(route);
    p.status = 'claimed';
    p.claim = {
      routeId: route.routeId,
      clientId: route.clientId,
      blob: body.blob,
      claimedAt: now(),
    };
    forwardClaim(p);
    log.info('pairing claimed', { pairingId: id, routeId: route.routeId });
    void reply.status(201);
    return Promise.resolve({
      clientId: route.clientId,
      routeId: route.routeId,
      routeToken: token,
      hubRouteId: p.hubRouteId,
      offer: p.offer,
      expiresAt: iso(p.expiresAt),
    });
  });

  app.post('/v1/relay/pairings/:id/confirm', async (req) => {
    const hub = hubOf(req);
    const { id } = idParam.parse(req.params);
    const p = state.pairings.get(id);
    if (!p || p.hubRouteId !== hub.routeId)
      throw new HttpError(404, 'not_found', 'no such pairing');
    if (p.status !== 'claimed' || !p.claim)
      throw new HttpError(409, 'conflict', 'the pairing has not been claimed', {
        reason: 'not_claimed',
      });
    const route = state.routes.get(p.claim.routeId);
    state.pairings.delete(id);
    if (!route) throw new HttpError(410, 'expired', 'the claimed route is gone');
    state.activate(route);
    log.info('pairing confirmed', { pairingId: id, routeId: route.routeId });
    return Promise.resolve({ ok: true, clientId: route.clientId, routeId: route.routeId });
  });

  app.get('/v1/relay/routes', async (req) => {
    const hub = hubOf(req);
    return Promise.resolve({
      items: state.clientRoutesOf(hub.routeId).map((r) => ({
        routeId: r.routeId,
        clientId: r.clientId,
        status: r.status,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        connected: newest(r.routeId) !== null,
      })),
    });
  });

  app.delete('/v1/relay/routes/:routeId', async (req) => {
    const hub = hubOf(req);
    const { routeId } = routeParam.parse(req.params);
    const r = state.routes.get(routeId);
    if (!r || r.hubRouteId !== hub.routeId) throw new HttpError(404, 'not_found', 'no such route');
    if (r.pairingId) state.pairings.delete(r.pairingId);
    state.removeRoute(r, true, iso());
    queue.dropRoute(routeId);
    disconnectRoute(routeId, 'revoked');
    log.info('route revoked', { routeId });
    return Promise.resolve({ ok: true });
  });

  app.post('/v1/relay/push/register', async (req, reply) => {
    const r = clientOf(req);
    const body = pushBody.parse(req.body);
    state.setPush(r, {
      platform: body.platform,
      token: body.token,
      topic: body.topic ?? null,
      registeredAt: iso(),
    });
    void reply.status(201);
    return Promise.resolve({ ok: true });
  });

  // A notification for the Hub's own active client routes (FR-111): pushed to those with a
  // registration, at most `notifyPerRouteMinute` per route. The answer counts, nothing more.
  app.post('/v1/relay/push/notify', async (req) => {
    const hub = hubOf(req);
    const body = notifyBody.parse(req.body);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const t = now();
    for (const routeId of new Set(body.routes)) {
      const r = state.routes.get(routeId);
      if (!r || r.hubRouteId !== hub.routeId || r.status !== 'active' || !r.push) {
        skipped++;
        continue;
      }
      if (!notifyHits.take(routeId, t)) {
        skipped++;
        continue;
      }
      stats.pushes++;
      const out = await push
        .send({
          platform: r.push.platform,
          token: r.push.token,
          topic: r.push.topic,
          kind: 'notify',
          routeId,
          notification: body.notification,
        })
        .catch((err: unknown): PushOutcome => {
          log.warn('push notification failed', { err, routeId });
          return { ok: false, detail: 'failed' };
        });
      if (settlePush(r, out)) sent++;
      else failed++;
    }
    return { ok: true, sent, skipped, failed };
  });

  // The channel relay (webhook messages and the outbox) is not built: channels reach the Hub
  // directly or by polling (docs/13 §4). The routes exist and say so.
  const notBuilt = (_req: FastifyRequest, reply: FastifyReply) => {
    void reply.status(501).send({
      error: {
        code: 'not_implemented',
        message:
          'The channel relay (webhook messages and the outbox) is not built; channels reach the Hub directly or by polling.',
        retryable: false,
        details: { reason: 'channel_relay_not_built' },
      },
    });
  };
  app.post('/v1/relay/messages', notBuilt);
  app.get('/v1/relay/outbox', notBuilt);

  // ---- expiry --------------------------------------------------------------------------------
  /** Forget a Hub that is no longer used, with its client routes (their tokens stop working). */
  const forgetHub = (hub: HubRecord, why: string): void => {
    for (const r of state.removeHub(hub)) {
      queue.dropRoute(r.routeId);
      disconnectRoute(r.routeId, 'revoked');
    }
    queue.dropHub(hub.routeId);
    log.info('hub forgotten', { routeId: hub.routeId, why });
  };

  const sweep = () => {
    const t = now();
    queue.expireAll();
    for (const hub of [...state.hubs.values()]) {
      if (newest(hub.routeId)) continue;
      const last = Date.parse(hub.lastSeenAt ?? hub.createdAt);
      const routes = state.clientRoutesOf(hub.routeId).length;
      if (t - last >= limits.hubIdleTtlMs) forgetHub(hub, 'abandoned');
      else if (!routes && t - last >= limits.hubUnusedTtlMs) forgetHub(hub, 'unused');
    }
    for (const p of [...state.pairings.values()]) {
      if (p.status === 'open' && p.expiresAt <= t) state.pairings.delete(p.id);
      if (p.status === 'claimed' && p.claim && p.claim.claimedAt + limits.pendingRouteTtlMs <= t) {
        state.pairings.delete(p.id);
        const r = state.routes.get(p.claim.routeId);
        if (r?.status === 'pending') {
          state.removeRoute(r, true, iso(t));
          disconnectRoute(r.routeId, 'revoked');
        }
      }
    }
    registrations.sweep(t);
    claims.sweep(t);
    notifyHits.sweep(t);
    state.saveTouched();
  };
  const sweeper = setInterval(sweep, opts.sweepIntervalMs ?? 5_000);
  sweeper.unref();

  return {
    app,
    state,
    push,
    stats: () => ({
      ...stats,
      evicted: queue.evicted,
      queuedBytes: queue.totalBytes,
      connections,
    }),
    queued: (routeId) => queue.count(routeId),
    sweep,
    close: async () => {
      clearInterval(sweeper);
      for (const list of conns.values()) for (const c of [...list]) end(c, 'normal');
      await app.close();
      await state.flush();
    },
  };
}
