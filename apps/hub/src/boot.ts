// Boot area (FR-143; docs/23 §5.2; ADR-096 D2, D3, D5): low-level boot of novad devices and
// network boot from the Hub. Owner routes under /api/v1/devices/:id/boot (owner-only like every
// /api/v1/devices route; audited): the device's boot status, named boot profiles, trying a profile
// once with a watchdog and making a confirmed trial the default, each after an approval card for
// exactly that change and sent with a Hub-signed authorization, and clearing a pending one-shot
// (always allowed). `devices.boot.allowLowLevel` off: try and commit answer 403 `policy_denied`
// `{reason: low_level_boot_off}`. The Hub's watchdog fails a trial with no report by its deadline
// + 120 s and tells the owner. Kernel arguments in profiles are not supported in M7.5.
//
// Public routes and how each authenticates (both 404 while `devices.pxe.enabled` is off):
// - `GET /boot/ipxe/:token`: the device's PXE boot token in the path (`nvb_` + 256 random bits,
//   only its hash stored, shown once, rotatable and revocable; a revoked device's token stops at
//   once). An unknown token is 404 too. Rate-limited per address; every fetch is audited.
// - `GET /boot/images/:token/:name`: the same token; `name` is a plain file name directly in
//   `<dataDir>/boot-images` (no paths, no `..`, no symbolic links). Single byte ranges are served.
//   Rate-limited per address; audited per fetch.
// Nova runs no DHCP or TFTP: a DHCP server's next-server/filename or an iPXE build's embedded
// script points at the menu route.
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  HUB_ERROR_CODES,
  NovaError,
  bootEmptyBodySchema,
  commitBootAttemptSchema,
  createBootProfileSchema,
  idSchema,
  tryBootProfileSchema,
  updateBootProfileSchema,
  type DeviceBootView,
  type HubErrorCode,
} from '@nova/shared';
import {
  BootService,
  PxeService,
  SlidingWindowLimiter,
  bootAuthorizer,
  callDevice,
  managementTokenRef,
  type AuditSink,
  type BootDeviceLink,
  type BootPowerCycleLookup,
  type DeviceService,
  type DeviceTransport,
  type Notifier,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** What signs device authorizations: the Hub identity (`trust.identity`), once it is loaded. */
export interface BootSigner {
  sign(bytes: Uint8Array | string): Buffer;
}

export interface BootArea extends HubArea {
  service: BootService;
  pxe: PxeService;
  /** `policy.lowLevelBoot` of the heartbeat answer (`devices.service.useBootPolicy`, D3). */
  lowLevelBoot(): Promise<boolean>;
  /** A device's heartbeat `events` (D5 `boot.watchdog.ok|reverted`; others are ignored). */
  heartbeatEvents(accountId: string, deviceId: string, events: readonly unknown[]): Promise<void>;
  useAudit(audit: AuditSink): void;
  useNotifier(notifier: Notifier): void;
  /** The Hub identity that signs authorizations; null until it is loaded. */
  useHubIdentity(identity: () => BootSigner | null): void;
  /** The out-of-band area's power cycle link for a device, for a failed trial's alert. */
  usePowerCycle(lookup: BootPowerCycleLookup | null): void;
}

export interface BootDeps {
  /** The devices area's service: the registry, its management channel and revocations. */
  devices: DeviceService;
  audit?: AuditSink;
  notifier?: Notifier;
  hubIdentity?: () => BootSigner | null;
  /** Tests: a clock, a transport to devices, the watchdog's interval, the public limits. */
  now?: () => Date;
  transport?: DeviceTransport;
  sweepIntervalMs?: number;
  limits?: { scriptsPerMinute?: number; imagesPerMinute?: number };
}

const params = z.object({ id: idSchema });
const profileParams = z.object({ id: idSchema, pid: idSchema });
const attemptParams = z.object({ id: idSchema, aid: idSchema });
const requestParams = z.object({ id: idSchema, rid: idSchema });
const scriptParams = z.object({ token: z.string().max(100) });
const imageParams = z.object({ token: z.string().max(100), name: z.string().max(200) });

const CALL_TIMEOUT_MS = 30_000;

function notFound(): NovaError {
  return new NovaError('not_found', 'not found');
}

/** Profiles name an entry only: kernel arguments are not supported in M7.5 (ADR-096 D5). */
function noKernelArgs(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  if ('kernelArgs' in body || 'cmdline' in body || 'kernelArguments' in body)
    throw new NovaError(
      'capability_missing',
      'kernel arguments in boot profiles are not supported',
      {
        details: { reason: 'kernel_args_not_supported' },
      },
    );
}

/** One `bytes=` range of a file, null for the whole file, `invalid` for an unsatisfiable one. */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges or another unit: the whole file (RFC 9110 allows ignoring Range).
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (!a && !b) return 'invalid';
  let start: number;
  let end: number;
  if (!a) {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

export function setupBoot(ctx: HubContext, deps: BootDeps): Promise<BootArea> {
  const transport: DeviceTransport = deps.transport ?? deps.devices.managementTransport;
  const link: BootDeviceLink = {
    async device(accountId, deviceId) {
      const d = await deps.devices.device(accountId, deviceId);
      return {
        id: d.row.id,
        name: d.row.name,
        status: d.row.status,
        lastSeenAt: d.row.lastSeenAt,
      };
    },
    async call(accountId, deviceId, path, body) {
      const d = await deps.devices.device(accountId, deviceId);
      if (d.row.status === 'revoked')
        throw new NovaError('conflict', 'the device is revoked', {
          details: { reason: 'revoked' },
        });
      if (!d.endpoint)
        throw new NovaError('node_unavailable', 'the device has no management endpoint', {
          details: { reason: 'unreachable' },
        });
      const token = await ctx.secrets.get(managementTokenRef(d.row.id));
      if (!token)
        throw new NovaError('auth_missing', 'the Hub has no management token for this device');
      // An https endpoint goes over mutual TLS to exactly this device (D1, the devices area).
      return callDevice(transport, d.endpoint, token, path, body, CALL_TIMEOUT_MS, {
        deviceId: d.row.id,
        publicKey: d.row.publicKey,
      });
    }, // The device's toggles pushed before a privileged send (D3; the devices area).
    syncPolicy: (accountId, deviceId, opts) => deps.devices.syncPolicy(accountId, deviceId, opts),
  };
  let identity: (() => BootSigner | null) | null = deps.hubIdentity ?? null;
  const now = deps.now ?? (() => new Date());
  const service = new BootService({
    db: ctx.db,
    events: ctx.events,
    devices: link,
    log: ctx.log.child('boot'),
    settings: {
      allowLowLevel: () => ctx.setting('devices.boot.allowLowLevel'),
      watchdogSeconds: () => ctx.setting('devices.boot.watchdogSeconds'),
    },
    authorize: bootAuthorizer(() => identity?.() ?? null, now),
    now,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.sweepIntervalMs ? { sweepIntervalMs: deps.sweepIntervalMs } : {}),
  });
  const pxe = new PxeService({
    db: ctx.db,
    events: ctx.events,
    devices: link,
    imagesDir: join(ctx.dataDir, 'boot-images'),
    log: ctx.log.child('pxe'),
    now,
    ...(deps.audit ? { audit: deps.audit } : {}),
  });
  service.start();
  const limits = {
    scripts: new SlidingWindowLimiter({
      limit: deps.limits?.scriptsPerMinute ?? 30,
      windowMs: 60_000,
      now: () => now().getTime(),
    }),
    images: new SlidingWindowLimiter({
      limit: deps.limits?.imagesPerMinute ?? 120,
      windowMs: 60_000,
      now: () => now().getTime(),
    }),
  };

  // An approval card answered on the Hub sends its boot change (once).
  const off = ctx.events.bus.subscribe('approval.decided', (e) => {
    const p = e.payload;
    const approvalId = typeof p.approvalId === 'string' ? p.approvalId : null;
    const decidedBy = typeof p.decidedBy === 'string' ? p.decidedBy : '';
    // Boot cards are Hub-only (`answerIn: 'hub'`): a channel's answer never sends a change.
    if (
      !approvalId ||
      !e.accountId ||
      decidedBy.startsWith('device:') ||
      decidedBy.startsWith('channel:')
    )
      return;
    void service
      .onApprovalDecided(e.accountId, approvalId, typeof p.decision === 'string' ? p.decision : '')
      .catch((err: unknown) => ctx.log.warn('sending a boot change failed', { err }));
  });
  // A revoked device's requests and trials fail and its boot token stops at once.
  const offRevoked = deps.devices.onRevoked(async (accountId, deviceId) => {
    await service.onDeviceRevoked(accountId, deviceId);
    await pxe.onDeviceRevoked(accountId, deviceId);
  });

  ctx.diagnostics.add('boot', () => {
    const rows = ctx.db.raw
      .prepare('SELECT status, count(*) AS n FROM boot_attempt GROUP BY status')
      .all() as { status: string; n: number }[];
    const tokens = ctx.db.raw
      .prepare('SELECT count(*) AS n FROM pxe_token WHERE revoked_at IS NULL')
      .get() as { n: number };
    return Promise.resolve({
      attempts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      pxeTokens: tokens.n,
    });
  });

  const hubUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
  const pxeOn = async () => (await ctx.setting('devices.pxe.enabled')) === true;

  function register(app: FastifyInstance): void {
    // ---- status and profiles ---------------------------------------------------------------
    app.get('/api/v1/devices/:id/boot', async (req): Promise<DeviceBootView> => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const view = await service.view(accountId, id);
      return { ...view, pxeEnabled: await pxeOn(), pxe: await pxe.tokenView(accountId, id) };
    });

    app.get('/api/v1/devices/:id/boot/profiles', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.profiles(accountId, params.parse(req.params).id) };
    });

    app.post('/api/v1/devices/:id/boot/profiles', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      noKernelArgs(req.body);
      const body = createBootProfileSchema.parse(req.body);
      const out = await service.createProfile(accountId, params.parse(req.params).id, body);
      void reply.status(201);
      return out;
    });

    app.patch('/api/v1/devices/:id/boot/profiles/:pid', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = profileParams.parse(req.params);
      noKernelArgs(req.body);
      return service.updateProfile(accountId, p.id, p.pid, updateBootProfileSchema.parse(req.body));
    });

    app.delete('/api/v1/devices/:id/boot/profiles/:pid', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = profileParams.parse(req.params);
      await service.deleteProfile(accountId, p.id, p.pid);
      return { ok: true };
    });

    // ---- privileged changes: approval, then a signed authorization -------------------------
    app.post('/api/v1/devices/:id/boot/profiles/:pid/try', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const p = profileParams.parse(req.params);
      const body = tryBootProfileSchema.parse(req.body ?? {});
      const out = await service.requestTry(accountId, p.id, p.pid, body);
      void reply.status(202);
      return out;
    });

    app.get('/api/v1/devices/:id/boot/attempts/:aid', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = attemptParams.parse(req.params);
      return service.attempt(accountId, p.id, p.aid);
    });

    app.post('/api/v1/devices/:id/boot/attempts/:aid/commit', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const p = attemptParams.parse(req.params);
      const body = commitBootAttemptSchema.parse(req.body ?? {});
      const out = await service.requestCommit(accountId, p.id, p.aid, {
        confirmUnverified: body.confirmUnverified === true,
      });
      void reply.status(202);
      return out;
    });

    app.post('/api/v1/devices/:id/boot/revert', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      bootEmptyBodySchema.parse(req.body ?? {});
      const out = await service.revert(accountId, id);
      if (out.status === 'failed' && out.error) {
        const code = (HUB_ERROR_CODES as readonly string[]).includes(out.error.code)
          ? (out.error.code as HubErrorCode)
          : 'server_error';
        throw new NovaError(code, out.error.message || 'the device did not clear its one-shot', {
          details: { reason: out.error.reason, requestId: out.id },
        });
      }
      return out;
    });

    app.get('/api/v1/devices/:id/boot/requests/:rid', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = requestParams.parse(req.params);
      return service.request(accountId, p.id, p.rid);
    });

    // ---- PXE: the owner's side -------------------------------------------------------------
    app.get('/api/v1/devices/boot-images', async (req) => {
      await ctx.accountOf(req);
      return { enabled: await pxeOn(), folder: pxe.imagesDir, items: pxe.images() };
    });

    app.post('/api/v1/devices/:id/boot/pxe/token', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      bootEmptyBodySchema.parse(req.body ?? {});
      const out = await pxe.createToken(accountId, params.parse(req.params).id, hubUrlOf(req));
      // Shown once: no cache and no idempotent replay may keep it.
      void reply.header('cache-control', 'no-store').status(201);
      return out;
    });

    app.delete('/api/v1/devices/:id/boot/pxe/token', async (req) => {
      const accountId = await ctx.accountOf(req);
      return pxe.revokeToken(accountId, params.parse(req.params).id);
    });

    // ---- PXE: the public routes (the boot token authenticates) -----------------------------
    app.get('/boot/ipxe/:token', async (req, reply) => {
      if (!(await pxeOn())) throw notFound();
      if (!limits.scripts.take(req.ip))
        throw new NovaError('rate_limited', 'too many boot menu requests', {
          details: { reason: 'address_rate_limited', retryAfter: 60 },
        });
      const p = scriptParams.safeParse(req.params);
      const script = p.success ? await pxe.script(p.data.token, hubUrlOf(req), req.ip) : null;
      if (script === null) throw notFound();
      void reply.header('cache-control', 'no-store').type('text/plain; charset=utf-8');
      return script;
    });

    app.get('/boot/images/:token/:name', async (req, reply) => {
      if (!(await pxeOn())) throw notFound();
      if (!limits.images.take(req.ip))
        throw new NovaError('rate_limited', 'too many boot image requests', {
          details: { reason: 'address_rate_limited', retryAfter: 60 },
        });
      const p = imageParams.safeParse(req.params);
      const range = req.headers.range ?? null;
      const file = p.success ? await pxe.image(p.data.token, p.data.name, req.ip, range) : null;
      if (!file) throw notFound();
      const r = byteRange(range ?? undefined, file.size);
      void reply
        .header('cache-control', 'no-store')
        .header('accept-ranges', 'bytes')
        .type('application/octet-stream');
      if (r === 'invalid') {
        void reply.status(416).header('content-range', `bytes */${file.size}`);
        return reply.send('');
      }
      if (r) {
        void reply
          .status(206)
          .header('content-range', `bytes ${r.start}-${r.end}/${file.size}`)
          .header('content-length', String(r.end - r.start + 1));
        return reply.send(createReadStream(file.path, { start: r.start, end: r.end }));
      }
      void reply.header('content-length', String(file.size));
      return reply.send(createReadStream(file.path));
    });
  }

  return Promise.resolve({
    service,
    pxe,
    lowLevelBoot: () => service.lowLevelBoot(),
    heartbeatEvents: (accountId, deviceId, events) =>
      service.heartbeatEvents(accountId, deviceId, events),
    useAudit: (a) => {
      service.useAudit(a);
      pxe.useAudit(a);
    },
    useNotifier: (n) => service.useNotifier(n),
    useHubIdentity: (fn) => {
      identity = fn;
    },
    usePowerCycle: (lookup) => service.usePowerCycle(lookup),
    register,
    close: () => {
      off();
      offRevoked();
      service.stop();
      return Promise.resolve();
    },
  });
}
