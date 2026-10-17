// Add Device area (FR-132, FR-140; docs/22 §4, §9; contracts/hub-api.md §1 "Auth & devices";
// ADR-094). The owner starts a pairing and approves requests with a session. Three routes are
// public and authenticate another way (Add Device v2, commit-then-reveal): `add/complete` by the
// pairing code (single use, 5 minutes, five wrong codes burn it) with a commitment to the device's
// secret nonce; `add/reveal` by that commitment and an Ed25519 signature of the device key (a bad
// one burns the request); `add/status/:requestId` by the device key's signature over the request
// id and a fresh time. All are rate-limited per client address. The first approved
// status poll hands out the grant once: a device session (a browser also gets the session cookie)
// or a one-use novad / compute enrollment token bound to the device key. Revocation (any kind)
// deletes the device's sessions and blocks its key.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ADD_DEVICE_SIGNATURE_HEADER,
  ADD_DEVICE_TIME_HEADER,
  NovaError,
  addDeviceApproveSchema,
  addDeviceRequestsQuerySchema,
  addDeviceStartSchema,
  deviceScopesSchema,
  idSchema,
  type AddDeviceBootstrap,
  type AddDeviceRole,
  type AddDeviceStartView,
  type DeviceEnrollToken,
} from '@nova/shared';
import {
  PairingService,
  SlidingWindowLimiter,
  type AuditSink,
  type EnrollKeyBinding,
  type Notifier,
  type PairingCertIssuer,
  type PairingHubIdentity,
  type PairingRelayOpener,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/**
 * What the agent-dist area builds: the one-line install command, or why there is none. The command
 * carries the pairing id (`--pairing`), so its code never spends the code-only guess budget.
 */
export type AddDeviceBootstrapBuilder = (
  role: AddDeviceRole,
  code: string,
  hubUrl: string,
  pairingId: string,
) => AddDeviceBootstrap | Promise<AddDeviceBootstrap>;

/** An endpoint the network area advertises (only healthy ones go into the QR payload). */
export interface AddDeviceEndpoint {
  url: string;
  health?: string;
}

/** The devices area's service, as far as Add Device needs it. */
export interface AddDeviceNovad {
  createEnrollToken(
    accountId: string,
    roles: readonly string[],
    hubUrl: string,
    bind?: EnrollKeyBinding,
  ): Promise<DeviceEnrollToken>;
  onRevoked(hook: (accountId: string, deviceId: string) => void | Promise<void>): () => void;
}

export interface AddDeviceArea extends HubArea {
  service: PairingService;
  /**
   * Revocation of devices neither compute nodes nor novad manage (browsers, apps, approved devices
   * that never registered), for `registerNodeRoutes`' `POST /api/v1/devices/:id/revoke`.
   */
  revoker: { revoke(accountId: string, deviceId: string): Promise<void> };
  useAudit(audit: AuditSink): void;
  useNotifier(notifier: Notifier): void;
  /** novad enrollment tokens and novad revocations (`addDevice.useDevices(devices.service)`). */
  useDevices(devices: AddDeviceNovad): void;
  /**
   * The Hub identity (trust area): its fingerprint for the QR payload and the confirmation, and its
   * signer for the reveal answer (`hubSignature`). Null while it is not loaded.
   */
  useHubIdentity(identity: () => PairingHubIdentity | null): void;
  /** Device certificates (trust area); a grant carries one when it can be issued. */
  useCertIssuer(issuer: PairingCertIssuer): void;
  /** The bootstrap command (agent-dist area). */
  useBootstrap(builder: AddDeviceBootstrapBuilder): void;
  /** Healthy endpoints to embed in the QR payload (network area). */
  useEndpoints(list: () => Promise<readonly AddDeviceEndpoint[]>): void;
  /** Relay pairing slots for `transport: relay` (relay area). */
  useRelayPairing(opener: PairingRelayOpener): void;
}

export interface AddDeviceDeps {
  audit?: AuditSink;
  notifier?: Notifier;
  /** Tests: a clock and lower public limits. */
  now?: () => Date;
  limits?: {
    complete?: { limit: number; windowMs: number };
    reveal?: { limit: number; windowMs: number };
    status?: { limit: number; windowMs: number };
  };
  /** The Hub's session cookie name (`SESSION_COOKIE` in app.ts). */
  sessionCookie?: string;
  sweepIntervalMs?: number;
}

/** Endpoints carried in the QR payload at most (the code must stay scannable). */
const MAX_QR_ENDPOINTS = 4;
const NO_BUILD: AddDeviceBootstrap = {
  command: null,
  why: 'This Hub has no novad build to install yet; add the device from its own app or browser.',
};

const requestParams = z.object({ id: idSchema });
const statusParams = z.object({ requestId: idSchema });
const deviceParams = z.object({ id: idSchema });

function hubUrlOf(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The QR payload, the native deep link and the page URL (docs/22 §4.1, docs/04 §5.1). */
export function addDeviceLinks(input: {
  hubUrl: string;
  pairingId: string;
  code: string;
  hubFingerprint: string | null;
  endpoints: readonly string[];
  relay: { relayUrl: string; relayPairingId: string } | null;
}): { qr: string; deepLink: string; pageUrl: string } {
  const q = new URLSearchParams({ p: input.pairingId });
  if (input.hubFingerprint) q.set('fp', input.hubFingerprint);
  for (const e of input.endpoints) q.append('e', e);
  if (input.relay) {
    q.set('r', input.relay.relayUrl);
    q.set('rp', input.relay.relayPairingId);
  }
  // The code rides in the fragment, which browsers never send to a server.
  const fragment = `#c=${encodeURIComponent(input.code)}`;
  const deep = new URLSearchParams({ h: input.hubUrl });
  for (const [k, v] of q) deep.append(k, v);
  return {
    qr: `${input.hubUrl}/add-device?${q.toString()}${fragment}`,
    deepLink: `nova://add-device?${deep.toString()}${fragment}`,
    pageUrl: `${input.hubUrl}/add-device?${new URLSearchParams({ p: input.pairingId }).toString()}`,
  };
}

export function setupAddDevice(ctx: HubContext, deps: AddDeviceDeps = {}): Promise<AddDeviceArea> {
  const log = ctx.log.child('add-device');
  const service = new PairingService({
    db: ctx.db,
    events: ctx.events,
    log,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sweepIntervalMs ? { sweepIntervalMs: deps.sweepIntervalMs } : {}),
    settings: {
      enabled: () => ctx.setting('devices.add.enabled'),
      sessionDays: () => ctx.setting('devices.add.sessionDays'),
    },
    grants: {
      compute: async (g) =>
        (
          await ctx.nodes.createEnrollToken(g.accountId, {
            publicKey: g.publicKey,
            deviceId: g.deviceId,
          })
        ).token,
    },
  });
  const nowMs = deps.now ? () => deps.now!().getTime() : () => Date.now();
  const completeLimiter = new SlidingWindowLimiter({
    limit: deps.limits?.complete?.limit ?? 10,
    windowMs: deps.limits?.complete?.windowMs ?? 60_000,
    now: nowMs,
  });
  const revealLimiter = new SlidingWindowLimiter({
    limit: deps.limits?.reveal?.limit ?? 10,
    windowMs: deps.limits?.reveal?.windowMs ?? 60_000,
    now: nowMs,
  });
  const statusLimiter = new SlidingWindowLimiter({
    limit: deps.limits?.status?.limit ?? 120,
    windowMs: deps.limits?.status?.windowMs ?? 60_000,
    now: nowMs,
  });
  const cookieName = deps.sessionCookie ?? 'nova_session';
  let bootstrap: AddDeviceBootstrapBuilder | null = null;
  let endpoints: (() => Promise<readonly AddDeviceEndpoint[]>) | null = null;
  const offs: (() => void)[] = [];

  // A revoked compute node's key is blocked and audited here (the node registry does not audit).
  offs.push(
    ctx.nodes.onRevoked((nodeId) => {
      service
        .deviceRevoked(nodeId, { audit: true })
        .catch((err: unknown) => log.warn('revoked node not recorded', { err }));
    }),
  );
  service.startSweeper();

  const limited = (limiter: SlidingWindowLimiter, req: FastifyRequest) => {
    if (!limiter.take(req.ip)) {
      throw new NovaError('rate_limited', 'too many requests from this address', {
        details: { reason: 'address_rate_limited' },
        action: 'Wait a minute and try again',
      });
    }
  };

  async function endpointsForQr(): Promise<string[]> {
    if (!endpoints) return [];
    try {
      const list = await endpoints();
      return list
        .filter((e) => (e.health ?? 'ok') === 'ok' && /^https?:\/\//.test(e.url))
        .map((e) => e.url)
        .slice(0, MAX_QR_ENDPOINTS);
    } catch (err) {
      log.warn('endpoints unavailable for the QR payload', { err });
      return [];
    }
  }

  async function bootstrapFor(
    role: AddDeviceRole,
    code: string,
    hubUrl: string,
    pairingId: string,
  ): Promise<AddDeviceBootstrap> {
    if (!bootstrap) return NO_BUILD;
    try {
      const b = await bootstrap(role, code, hubUrl, pairingId);
      return {
        command: b.command ?? null,
        powershell: b.powershell ?? null,
        why: b.command || b.powershell ? null : (b.why ?? NO_BUILD.why),
      };
    } catch (err) {
      log.warn('bootstrap command not built', { err });
      return { command: null, why: 'The install command could not be built; see the Hub log.' };
    }
  }

  function register(app: FastifyInstance): void {
    // ---- owner (session) --------------------------------------------------------------------
    app.post('/api/v1/devices/add/start', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = addDeviceStartSchema.parse(req.body ?? {});
      const hubUrl = hubUrlOf(req);
      const started = await service.start(accountId, body);
      const hubFingerprint = service.hubFingerprint();
      const urls = await endpointsForQr();
      const out: AddDeviceStartView = {
        pairingId: started.pairingId,
        code: started.code,
        expiresAt: started.expiresAt,
        role: started.role,
        scopes: started.scopes,
        transport: started.transport,
        ...addDeviceLinks({
          hubUrl,
          pairingId: started.pairingId,
          code: started.code,
          hubFingerprint,
          endpoints: urls,
          relay: started.relay,
        }),
        bootstrap: await bootstrapFor(started.role, started.code, hubUrl, started.pairingId),
        hubFingerprint,
        endpoints: urls,
        relay: started.relay,
      };
      void reply.header('cache-control', 'no-store').status(201);
      return out;
    });

    app.get('/api/v1/devices/add/requests', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = addDeviceRequestsQuerySchema.parse(req.query);
      return { items: await service.requests(accountId, q.status ?? 'pending') };
    });

    app.post('/api/v1/devices/add/requests/:id/approve', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = requestParams.parse(req.params);
      const body = addDeviceApproveSchema.parse(req.body ?? {});
      return service.approve(accountId, id, body.confirmation);
    });

    app.post('/api/v1/devices/add/requests/:id/deny', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.deny(accountId, requestParams.parse(req.params).id);
    });

    // Every device record, whatever it runs (FR-140), and its scopes (docs/22 §4.2).
    app.get('/api/v1/devices/all', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.list(accountId) };
    });

    app.put('/api/v1/devices/:id/scopes', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = deviceParams.parse(req.params);
      const body = deviceScopesSchema.parse(req.body ?? {});
      return service.setScopes(accountId, id, body.scopes);
    });

    // ---- the new device (public; see the file comment) -----------------------------------------
    app.post('/api/v1/devices/add/complete', async (req, reply) => {
      limited(completeLimiter, req);
      const out = await service.complete(req.body ?? {}, { ip: req.ip });
      void reply.header('cache-control', 'no-store').status(202);
      return out;
    });

    app.post('/api/v1/devices/add/reveal', async (req, reply) => {
      limited(revealLimiter, req);
      const out = await service.reveal(
        req.body ?? {},
        {
          time: header(req, ADD_DEVICE_TIME_HEADER),
          signature: header(req, ADD_DEVICE_SIGNATURE_HEADER),
        },
        { ip: req.ip },
      );
      void reply.header('cache-control', 'no-store');
      return out;
    });

    app.get('/api/v1/devices/add/status/:requestId', async (req, reply) => {
      limited(statusLimiter, req);
      const { requestId } = statusParams.parse(req.params);
      const result = await service.status(
        requestId,
        {
          time: header(req, ADD_DEVICE_TIME_HEADER),
          signature: header(req, ADD_DEVICE_SIGNATURE_HEADER),
        },
        { hubUrl: hubUrlOf(req) },
      );
      void reply.header('cache-control', 'no-store');
      const grant = result.view.grant;
      if (grant?.type === 'session' && result.kind === 'browser' && result.sessionMaxAgeS) {
        // The browser that joined is signed in at once, like the owner after setup.
        void reply.setCookie(cookieName, grant.token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: req.protocol === 'https',
          path: '/',
          maxAge: result.sessionMaxAgeS,
        });
      }
      return result.view;
    });
  }

  return Promise.resolve({
    service,
    revoker: { revoke: (accountId, deviceId) => service.revokeDevice(accountId, deviceId) },
    useAudit: (a) => service.useAudit(a),
    useNotifier: (n) => service.useNotifier(n),
    useDevices: (devices) => {
      service.useGrants({
        novad: async (g) =>
          (
            await devices.createEnrollToken(g.accountId, [g.role], g.hubUrl, {
              publicKey: g.publicKey,
              deviceId: g.deviceId,
            })
          ).token,
      });
      // novad audits its own revocations; here its sessions go and its key is blocked.
      offs.push(
        devices.onRevoked((accountId, deviceId) =>
          service.deviceRevoked(deviceId, { accountId, audit: false }),
        ),
      );
    },
    useHubIdentity: (identity) => service.useHubIdentity(identity),
    useCertIssuer: (issuer) => service.useCertIssuer(issuer),
    useBootstrap: (builder) => {
      bootstrap = builder;
    },
    useEndpoints: (list) => {
      endpoints = list;
    },
    useRelayPairing: (opener) => service.useRelayPairing(opener),
    register,
    close: () => {
      for (const off of offs) off();
      service.stopSweeper();
      return Promise.resolve();
    },
  });
}
