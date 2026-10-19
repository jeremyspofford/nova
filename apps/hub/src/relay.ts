// Relay area (FR-137; docs/22 §3; contracts/hub-api.md §1 "Auth & devices", contracts/rest-api.md
// §3). Owner routes under /api/v1/relay need a session: the settings (enabled, URL, self-hosted;
// security settings), a reachability test, and the paired clients with revoke. The connector
// itself (packages/core RelayHub) connects out to the Relay; requests that clients tunnel through
// it are dispatched into this Hub with Fastify's `inject`, carrying the client's own Authorization
// header, so the Hub authenticates them exactly like direct requests (the Relay's route token never
// authorizes anything here). Only /api/v1 routes are reachable that way, and not the WebSocket.
// A private Relay's registration token (M7) goes into the vault with
// `PUT /api/v1/relay/registration-token`; `relay.registrationTokenRef` names it and the connector
// sends it only when it registers.
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  NovaError,
  RELAY_REGISTRATION_TOKEN_REF,
  SETTINGS,
  effectiveRelayUrl,
  patchRelaySchema,
  relayRegistrationTokenSchema,
  type RelayConfigView,
  type RelayRegistrationTokenView,
} from '@nova/shared';
import {
  RelayHub,
  relayRegistrationSecret,
  type AuditSink,
  type RelayDispatch,
  type RelayHubIdentity,
  type RelayHubOptions,
  type RelayPairingSeam,
  type RelayStatus,
} from '@nova/core';
import { schema } from '@nova/storage';
import type { HubArea, HubContext } from './hub-context.ts';

export interface RelayArea extends HubArea {
  hub: RelayHub;
  /** Add Device's `useRelayPairing` opener for `transport: relay` (docs/22 §4). */
  openPairing(input: {
    accountId: string;
    pairingId: string;
    expiresAt: string;
    code: string;
  }): Promise<{ relayUrl: string; relayPairingId: string }>;
  /** The network area's `useEndpointSource` entry (the Relay URL with the connector's health). */
  endpointSource: ReturnType<RelayHub['endpointSource']>;
  status(): RelayStatus;
  useAudit(audit: AuditSink): void;
  /** The Add Device service (`requestFromRelay`, `onDecided`). */
  usePairing(seam: RelayPairingSeam): void;
  /**
   * The Relay's origins for the web app's `connect-src` (the join page and the Relay transport
   * reach it from the browser); empty while the Relay is off.
   */
  connectOrigins(): string[];
  useHubIdentity(fn: () => RelayHubIdentity | null): void;
  /** The Hub app tunneled requests are dispatched into (the lead passes the Hub instance). */
  useInject(app: FastifyInstance): void;
  /** Revoking a paired client revokes its device too (the add-device area's revocation). */
  onClientRevoked(fn: (accountId: string, deviceId: string) => Promise<void> | void): void;
  /** A device revoked elsewhere loses its Relay route (also done on `device.status.changed`). */
  revokeDevice(accountId: string, deviceId: string): Promise<void>;
}

export interface RelayDeps extends Pick<
  RelayHubOptions,
  | 'fetch'
  | 'webSocket'
  | 'timers'
  | 'backoff'
  | 'pingIntervalMs'
  | 'retransmitMs'
  | 'kdfIterations'
  | 'now'
> {
  audit?: AuditSink;
  /** The Hub app to dispatch tunneled requests into; `useInject` sets it later. */
  app?: FastifyInstance;
  /** The Host header of tunneled requests (one of the Hub's own names; default `localhost`). */
  hostHeader?: string;
}

const params = z.object({ id: z.string().min(1).max(64) });

/** Request headers a tunneled request may carry into the Hub; everything else is dropped. */
const INNER_HEADERS = new Set([
  'authorization',
  // A request queued offline carries its key through the tunnel too (FR-112).
  'idempotency-key',
  'content-type',
  'accept',
  'accept-language',
  'last-event-id',
  'if-none-match',
  'if-match',
  'if-modified-since',
  'range',
]);
/** Response headers that do not cross the tunnel. */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'set-cookie',
  'upgrade',
]);

function json(status: number, code: string, message: string) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: [
      new TextEncoder().encode(JSON.stringify({ error: { code, message, retryable: false } })),
    ],
  };
}

/**
 * The URL a tunneled request may reach: normalised the way the Hub's router will see it (dot
 * segments resolved, backslashes refused), inside /api/v1/, and with no encoded dot, slash or
 * backslash that could turn into one later. Null otherwise.
 */
export function tunnelUrl(path: string): URL | null {
  // The path part only: a query may carry encoded slashes (a file path parameter).
  const raw = path.split('?')[0] ?? '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/%(2e|2f|5c)/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(path, 'http://localhost');
  } catch {
    return null;
  }
  if (u.origin !== 'http://localhost' || u.hash) return null;
  return u.pathname.startsWith('/api/v1/') ? u : null;
}

/** Serve a tunneled request with `inject` on the Hub app (streamed, so SSE flows as produced). */
export function injectDispatch(
  target: () => FastifyInstance | null,
  hostHeader = 'localhost',
): RelayDispatch {
  return async (req, signal) => {
    const app = target();
    if (!app) return json(503, 'node_unavailable', 'the Hub is starting');
    const url = tunnelUrl(req.path);
    if (!url) return json(404, 'not_found', 'only /api/v1 routes are reachable through the Relay');
    if (url.pathname === '/api/v1/ws' || url.pathname.startsWith('/api/v1/ws/'))
      return json(400, 'capability_missing', 'use /api/v1/events/stream through the Relay');
    const headers: Record<string, string> = { host: hostHeader };
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (INNER_HEADERS.has(name) || (name.startsWith('x-nova-') && name !== 'x-nova-relay-client'))
        headers[name] = v;
    }
    const method = req.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    const res = await app.inject({
      method,
      // The normalised path: what was checked is what runs.
      url: url.pathname + url.search,
      headers,
      ...(req.body ? { payload: Buffer.from(req.body) } : {}),
      payloadAsStream: true,
      signal,
      // Per-client rate limits key on the address; loopback is never trusted for being local.
      remoteAddress: `relay:${req.client.id}`,
    });
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || DROP_RESPONSE.has(k.toLowerCase())) continue;
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const body = res.stream();
    signal.addEventListener('abort', () => body.destroy(), { once: true });
    return { status: res.statusCode, headers: out, body: body as AsyncIterable<Uint8Array> };
  };
}

export async function setupRelay(ctx: HubContext, deps: RelayDeps = {}): Promise<RelayArea> {
  const log = ctx.log.child('relay');
  let target: FastifyInstance | null = deps.app ?? null;
  const settings = async () => {
    const [enabled, url, selfHosted, registrationTokenRef] = await Promise.all([
      ctx.setting('relay.enabled'),
      ctx.setting('relay.url'),
      ctx.setting('relay.selfHosted'),
      ctx.setting('relay.registrationTokenRef'),
    ]);
    return { enabled, url: effectiveRelayUrl({ url, selfHosted }), registrationTokenRef };
  };
  const hub = new RelayHub({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    log,
    settings,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.webSocket ? { webSocket: deps.webSocket } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.backoff ? { backoff: deps.backoff } : {}),
    ...(deps.pingIntervalMs ? { pingIntervalMs: deps.pingIntervalMs } : {}),
    ...(deps.retransmitMs ? { retransmitMs: deps.retransmitMs } : {}),
    ...(deps.kdfIterations ? { kdfIterations: deps.kdfIterations } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  let audit: AuditSink | null = deps.audit ?? null;
  hub.useDispatch(injectDispatch(() => target, deps.hostHeader));

  // The Relay's origins for the Content-Security-Policy, kept current with its settings.
  let origins: string[] = [];
  const refreshOrigins = async () => {
    const s = await settings();
    origins = s.enabled ? relayConnectOrigins(s.url) : [];
  };
  await refreshOrigins();

  // A change to any relay.* setting, here or through PATCH /api/v1/settings, applies at once.
  const off = ctx.events.bus.subscribe('settings.changed', (e) => {
    const key = e.payload.key;
    if (typeof key === 'string' && key.startsWith('relay.')) {
      hub.reconfigure().catch((err: unknown) => log.warn('relay reconfigure failed', { err }));
      refreshOrigins().catch((err: unknown) => log.warn('relay origins refresh failed', { err }));
    }
  });
  // A device revoked anywhere (Add Device, Devices, compute nodes) loses its Relay route.
  const offRevoked = ctx.events.bus.subscribe('device.status.changed', (e) => {
    const deviceId = e.payload.deviceId;
    if (e.payload.status !== 'revoked' || typeof deviceId !== 'string' || !e.accountId) return;
    hub
      .revokeDevice(e.accountId, deviceId)
      .catch((err: unknown) => log.warn('revoking a device’s Relay client failed', { err }));
  });
  // Connecting out may wait on the network: never hold up the Hub's start for it.
  hub.start().catch((err: unknown) => log.warn('relay start failed', { err }));

  const counts = (accountId: string) => {
    const rows = ctx.db.raw
      .prepare(
        `SELECT status, count(*) AS n FROM relay_client WHERE account_id = ? GROUP BY status`,
      )
      .all(accountId) as { status: string; n: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return { active: by.active ?? 0, pending: by.pending ?? 0 };
  };

  const view = async (accountId: string): Promise<RelayConfigView & RelayRegistrationTokenView> => {
    const [enabled, url, selfHosted, tokenRef] = await Promise.all([
      ctx.setting('relay.enabled'),
      ctx.setting('relay.url'),
      ctx.setting('relay.selfHosted'),
      ctx.setting('relay.registrationTokenRef'),
    ]);
    return {
      enabled,
      url,
      selfHosted,
      effectiveUrl: effectiveRelayUrl({ url, selfHosted }),
      status: hub.status(),
      clients: counts(accountId),
      registrationToken: tokenRef !== '',
    };
  };

  ctx.diagnostics.add('relay', () => {
    const s = hub.status();
    const rows = ctx.db.raw
      .prepare('SELECT status, count(*) AS n FROM relay_client GROUP BY status')
      .all() as { status: string; n: number }[];
    return Promise.resolve({
      state: s.state,
      detail: s.detail,
      url: s.url,
      latencyMs: s.latencyMs,
      clients: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    });
  });

  /** Store one global setting; a managed lock wins and the write is refused (docs/14 §1). */
  async function writeSetting(
    accountId: string,
    key: 'relay.enabled' | 'relay.url' | 'relay.selfHosted' | 'relay.registrationTokenRef',
    value: unknown,
  ): Promise<void> {
    const parsed: unknown = SETTINGS[key].schema.parse(value);
    const { setting } = schema;
    const where = and(
      eq(setting.key, key),
      eq(setting.scopeKind, 'global'),
      eq(setting.scopeRef, ''),
    );
    const previous = (await ctx.db.orm.select().from(setting).where(where))[0] ?? null;
    const put = async (valueJson: string | null) => {
      await ctx.db.transaction(async () => {
        await ctx.db.orm.delete(setting).where(where);
        if (valueJson !== null)
          await ctx.db.orm.insert(setting).values({
            key,
            scopeKind: 'global',
            scopeRef: '',
            valueJson,
            updatedAt: new Date().toISOString(),
          });
      });
    };
    await put(JSON.stringify(parsed));
    if (JSON.stringify(await ctx.setting(key)) !== JSON.stringify(parsed)) {
      await put(previous?.valueJson ?? null);
      throw new NovaError('policy_denied', `${key} is set by managed policy`, {
        details: { reason: 'managed' },
      });
    }
    await ctx.events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId,
      payload: { key, scope: 'global' },
    });
  }

  function register(app: FastifyInstance): void {
    app.get('/api/v1/relay', async (req) => view(await ctx.accountOf(req)));

    app.patch('/api/v1/relay', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = patchRelaySchema.parse(req.body ?? {});
      const before = await view(accountId);
      const keys = [
        // The URL first, so turning the Relay on in the same change never sees the old URL.
        ['url', 'relay.url'],
        ['selfHosted', 'relay.selfHosted'],
        ['enabled', 'relay.enabled'],
      ] as const;
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const [field, key] of keys) {
        const value = body[field];
        if (value === undefined || value === before[field]) continue;
        await writeSetting(accountId, key, value);
        changed[field] = { from: before[field], to: value };
      }
      if (Object.keys(changed).length) {
        await audit
          ?.append({
            accountId,
            actor: 'user',
            kind: 'network',
            action: 'relay.change',
            resource: 'relay',
            detail: { changed },
          })
          .catch((err: unknown) => log.warn('relay audit failed', { err }));
        await hub.reconfigure();
      }
      return view(accountId);
    });

    // The token a private Relay asks for (M7): into the vault, never answered back; the setting
    // names the entry and the connector registers again with it if it was refused.
    app.put('/api/v1/relay/registration-token', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { token } = relayRegistrationTokenSchema.parse(req.body ?? {});
      const before = await ctx.setting('relay.registrationTokenRef');
      // The token is for the Relay in use now: stored with its URL, sent to no other Relay.
      const relayUrl = (await settings()).url.trim();
      if (token !== null && !relayUrl)
        throw new NovaError('conflict', 'set the Relay URL before its registration token', {
          details: { reason: 'relay_url_missing' },
        });
      if (token === null) {
        if (before) await writeSetting(accountId, 'relay.registrationTokenRef', '');
        await ctx.secrets.delete(RELAY_REGISTRATION_TOKEN_REF).catch(() => false);
      } else {
        await ctx.secrets.put(
          RELAY_REGISTRATION_TOKEN_REF,
          relayRegistrationSecret(token, relayUrl),
        );
        if (before !== RELAY_REGISTRATION_TOKEN_REF)
          await writeSetting(accountId, 'relay.registrationTokenRef', RELAY_REGISTRATION_TOKEN_REF);
      }
      await audit
        ?.append({
          accountId,
          actor: 'user',
          kind: 'network',
          action: token === null ? 'relay.registrationToken.clear' : 'relay.registrationToken.set',
          resource: 'relay',
          detail: token === null ? { ref: null } : { ref: RELAY_REGISTRATION_TOKEN_REF, relayUrl },
        })
        .catch((err: unknown) => log.warn('relay audit failed', { err }));
      // A registration the Relay refused for want of the token is tried again now.
      await hub.reconfigure();
      return view(accountId);
    });

    app.post('/api/v1/relay/test', async (req) => {
      await ctx.accountOf(req);
      return hub.test();
    });

    app.get('/api/v1/relay/clients', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: hub.listClients(accountId) };
    });

    app.post('/api/v1/relay/clients/:id/revoke', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const client = await hub.revokeClient(accountId, id);
      return { ok: true, client };
    });
  }

  return Promise.resolve({
    hub,
    openPairing: (input) => hub.openPairing(input),
    endpointSource: hub.endpointSource(),
    status: () => hub.status(),
    connectOrigins: () => origins,
    useAudit: (a) => {
      audit = a;
      hub.useAudit(a);
    },
    usePairing: (seam) => hub.usePairing(seam),
    useHubIdentity: (fn) => hub.useHubIdentity(fn),
    useInject: (app) => {
      target = app;
    },
    onClientRevoked: (fn) => hub.onClientRevoked(fn),
    revokeDevice: (accountId, deviceId) => hub.revokeDevice(accountId, deviceId),
    register,
    close: async () => {
      off();
      offRevoked();
      await hub.stop();
    },
  });
}

/**
 * `connect-src` sources for a Relay URL, given as http(s) or ws(s) (the settings suggest wss):
 * its HTTP origin for pairing and health, and its WebSocket origin for the connection (TLS for
 * https and wss, plain for http and ws). Anything else, or a URL that does not parse, gives none.
 */
export function relayConnectOrigins(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const tls = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!tls && u.protocol !== 'http:' && u.protocol !== 'ws:') return [];
  return tls ? [`https://${u.host}`, `wss://${u.host}`] : [`http://${u.host}`, `ws://${u.host}`];
}
