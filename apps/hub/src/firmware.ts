// Firmware area (FR-146; docs/23 §6; ADR-042, ADR-096 D2-D4): BIOS/firmware settings of novad
// devices, off by default. Every route needs a session and the Hub's owner (a member is refused
// `policy_denied` `{reason: owner_only}`); every write is audited with the values before and
// after. The flow: read (through the device, cached 60 s) -> plan (a dry run with a snapshot) ->
// request-approval (an approval card, risk high, showing the diff) -> apply (after the owner's
// "Allow once", with a Hub-signed authorization; reboot optional, with the device's watchdog) ->
// history; a snapshot can be rolled back (an approval too). The two toggles are set only here
// (`PUT /api/v1/devices/firmware/policy`; turning either on needs `{confirm: true}`) through the
// Hub's settings writer, whose `settings.changed` the ops subscriber audits once as
// `setting.changed` with before, after and confirmed. There is no model-facing tool (D3) and no
// public route.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FIRMWARE_SUPPORT_MATRIX,
  NovaError,
  applyFirmwareSchema,
  firmwareHistoryQuerySchema,
  firmwarePolicySchema,
  firmwareReadQuerySchema,
  idSchema,
  planFirmwareSchema,
  requestFirmwareApprovalSchema,
  rollbackFirmwareSchema,
  type FirmwarePolicyView,
  type FirmwareToggleKey,
} from '@nova/shared';
import {
  FirmwareService,
  isHubOwner,
  ownerOnlyError,
  type AuditSink,
  type DeviceAuthzSigner,
  type DeviceTransport,
  type FirmwareDeviceCall,
  type FirmwareDevices,
  type Notifier,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface FirmwareArea extends HubArea {
  service: FirmwareService;
  /**
   * `policy.firmwareChanges` of the heartbeat answer (D3), for
   * `devices.service.useFirmwarePolicy(firmware.heartbeatPolicy)`.
   */
  heartbeatPolicy(device: { accountId: string; deviceId: string }): Promise<boolean>;
  /**
   * A heartbeat's `events` (`firmware.watchdog.ok|reverted` close the change), for
   * `devices.service.onHeartbeatEvents(firmware.heartbeatEvents)`.
   */
  heartbeatEvents(accountId: string, deviceId: string, events: readonly unknown[]): Promise<void>;
  useAudit(audit: AuditSink): void;
  useNotifier(notifier: Notifier): void;
  /** The Hub identity that signs D2 authorizations (the trust area's, once loaded). */
  useIdentity(identity: () => DeviceAuthzSigner | null): void;
  /** Mutual TLS for https devices (ADR-096 D1). */
  useTlsTransport(transport: DeviceTransport | null): void;
  /** Send management calls through the devices area's own client instead. */
  useDeviceCall(call: FirmwareDeviceCall | null): void;
}

export interface FirmwareDeps {
  /** The devices area's registry (`devices.service`); its revocations clear the BIOS password. */
  devices: FirmwareDevices;
  /**
   * Write one global setting the way `PATCH /api/v1/settings` does (managed keys refuse): its
   * `settings.changed` carries before, after and `confirmed`, which the ops subscriber audits.
   */
  writeSetting: (
    accountId: string,
    key: FirmwareToggleKey,
    value: boolean,
    opts: { confirmed: boolean },
  ) => Promise<void>;
  audit?: AuditSink;
  notifier?: Notifier;
  identity?: () => DeviceAuthzSigner | null;
  /** Tests: the transport to plain HTTP devices, a clock, the watchdog sweep period. */
  transport?: DeviceTransport;
  tlsTransport?: DeviceTransport;
  now?: () => Date;
  sweepMs?: number;
}

const params = z.object({ id: idSchema });
const changeParams = z.object({ id: idSchema, changeId: idSchema });
const snapshotParams = z.object({ id: idSchema, snapshotId: idSchema });
const passwordBody = z.object({ password: z.string().min(1).max(256) }).strict();

const TOGGLES: Record<'allowChanges' | 'allowSecurityDegrading', FirmwareToggleKey> = {
  allowChanges: 'devices.firmware.allowChanges',
  allowSecurityDegrading: 'devices.firmware.allowSecurityDegrading',
};

export function setupFirmware(ctx: HubContext, deps: FirmwareDeps): Promise<FirmwareArea> {
  const service = new FirmwareService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    dataDir: ctx.dataDir,
    devices: deps.devices,
    log: ctx.log.child('firmware'),
    settings: {
      allowChanges: () => ctx.setting('devices.firmware.allowChanges'),
      allowSecurityDegrading: () => ctx.setting('devices.firmware.allowSecurityDegrading'),
      watchdogSeconds: () => ctx.setting('devices.firmware.watchdogSeconds'),
    },
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.identity ? { identity: deps.identity } : {}),
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.tlsTransport ? { tlsTransport: deps.tlsTransport } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  // An approval card answered anywhere moves its change to approved (or back to planned).
  const off = ctx.events.bus.subscribe('approval.decided', (e) => {
    const p = e.payload;
    const approvalId = typeof p.approvalId === 'string' ? p.approvalId : null;
    if (!approvalId || !e.accountId) return;
    void service
      .onApprovalDecided(e.accountId, approvalId, typeof p.decision === 'string' ? p.decision : '')
      .catch((err: unknown) => ctx.log.warn('a firmware approval update failed', { err }));
  });

  const timer = setInterval(() => {
    service
      .sweep()
      .catch((err: unknown) => ctx.log.warn('firmware watchdog sweep failed', { err }));
  }, deps.sweepMs ?? 30_000);
  timer.unref();

  ctx.diagnostics.add('firmware', async () => {
    const rows = ctx.db.raw
      .prepare('SELECT status, count(*) AS n FROM firmware_change GROUP BY status')
      .all() as { status: string; n: number }[];
    return {
      ...(await service.policy()),
      changes: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    };
  });

  /** The signed-in owner, or `policy_denied` `{reason: owner_only}` (docs/12 §1, ADR-095). */
  async function owner(req: FastifyRequest): Promise<string> {
    const accountId = await ctx.accountOf(req);
    if (!isHubOwner(ctx.db, accountId)) throw ownerOnlyError("the Hub's device firmware");
    return accountId;
  }

  async function setPolicy(accountId: string, body: unknown): Promise<FirmwarePolicyView> {
    const req = firmwarePolicySchema.parse(body);
    const before = await service.policy();
    const turningOn =
      (req.allowChanges === true && !before.allowChanges) ||
      (req.allowSecurityDegrading === true && !before.allowSecurityDegrading);
    if (turningOn && req.confirm !== true)
      throw new NovaError('policy_denied', 'turning this on needs an explicit confirmation', {
        details: { reason: 'consent_required' },
        action: 'Send {confirm: true} after reading what it allows',
      });
    for (const field of ['allowChanges', 'allowSecurityDegrading'] as const) {
      const value = req[field];
      if (value === undefined || value === before[field]) continue;
      // One audit entry per change: the ops subscriber's, from the writer's event (ADR-096 D3).
      await deps.writeSetting(accountId, TOGGLES[field], value, {
        confirmed: req.confirm === true,
      });
    }
    return service.policy();
  }

  function register(app: FastifyInstance): void {
    // ---- the toggles and the support matrix --------------------------------------------------
    app.get('/api/v1/devices/firmware/policy', async (req) => {
      await owner(req);
      return service.policy();
    });

    app.put('/api/v1/devices/firmware/policy', async (req) => {
      const accountId = await owner(req);
      return setPolicy(accountId, req.body);
    });

    app.get('/api/v1/devices/firmware/support', async (req) => {
      await owner(req);
      return { items: FIRMWARE_SUPPORT_MATRIX };
    });

    // ---- one device ------------------------------------------------------------------------
    app.get('/api/v1/devices/:id/firmware', async (req) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      const q = firmwareReadQuerySchema.parse(req.query ?? {});
      const view = await service.read(accountId, id, {
        fresh: q.fresh === '1' || q.fresh === 'true',
      });
      return { ...view, adminPasswordStored: await service.adminPasswordStored(id) };
    });

    app.post('/api/v1/devices/:id/firmware/plan', async (req, reply) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      const body = planFirmwareSchema.parse(req.body);
      const out = await service.plan(accountId, id, body.changes);
      void reply.status(201);
      return out;
    });

    app.get('/api/v1/devices/:id/firmware/changes/:changeId', async (req) => {
      const accountId = await owner(req);
      const p = changeParams.parse(req.params);
      return service.change(accountId, p.id, p.changeId);
    });

    app.post('/api/v1/devices/:id/firmware/changes/:changeId/request-approval', async (req) => {
      const accountId = await owner(req);
      const p = changeParams.parse(req.params);
      const body = requestFirmwareApprovalSchema.parse(req.body ?? {});
      return service.requestApproval(accountId, p.id, p.changeId, body.note);
    });

    app.post('/api/v1/devices/:id/firmware/changes/:changeId/apply', async (req) => {
      const accountId = await owner(req);
      const p = changeParams.parse(req.params);
      const body = applyFirmwareSchema.parse(req.body ?? {});
      return service.apply(accountId, p.id, p.changeId, { reboot: body.reboot });
    });

    app.post('/api/v1/devices/:id/firmware/snapshots/:snapshotId/rollback', async (req, reply) => {
      const accountId = await owner(req);
      const p = snapshotParams.parse(req.params);
      const body = rollbackFirmwareSchema.parse(req.body ?? {});
      const out = await service.rollback(accountId, p.id, p.snapshotId, body.note);
      void reply.status(202);
      return out;
    });

    app.get('/api/v1/devices/:id/firmware/history', async (req) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      const q = firmwareHistoryQuerySchema.parse(req.query ?? {});
      return service.history(accountId, id, q.limit);
    });

    // The BIOS admin password goes to the vault and is never returned (D4).
    app.put('/api/v1/devices/:id/firmware/admin-password', async (req, reply) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      const { password } = passwordBody.parse(req.body);
      void reply.header('cache-control', 'no-store');
      return service.setAdminPassword(accountId, id, password);
    });

    app.delete('/api/v1/devices/:id/firmware/admin-password', async (req) => {
      const accountId = await owner(req);
      const { id } = params.parse(req.params);
      return service.setAdminPassword(accountId, id, null);
    });
  }

  return Promise.resolve({
    service,
    heartbeatPolicy: () => service.firmwareChangesAllowed(),
    heartbeatEvents: (accountId, deviceId, events) =>
      service.onHeartbeatEvents(accountId, deviceId, events),
    useAudit: (a) => service.useAudit(a),
    useNotifier: (n) => service.useNotifier(n),
    useIdentity: (identity) => service.useIdentity(identity),
    useTlsTransport: (t) => service.useTlsTransport(t),
    useDeviceCall: (call) => service.useDeviceCall(call),
    register,
    close: () => {
      off();
      clearInterval(timer);
      service.close();
      return Promise.resolve();
    },
  });
}
