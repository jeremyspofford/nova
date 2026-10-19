// Out-of-band area (FR-147; docs/23 §7; ADR-043, ADR-096 D6): the BMCs the owner registers and
// the actions asked of them, under /api/v1/oob. Every route needs a session and the Hub's owner;
// all of it is off until the owner turns it on with POST /api/v1/oob/enable {confirm: true} (the
// settings route refuses to turn it on: 403 `policy_denied` `{reason: consent_required}`). Actions
// other than the read actions file a confirm-at-action approval card and run when the owner allows
// it; the area answers `approval.decided` for its cards. The Hub talks to BMCs directly (Redfish
// over HTTPS with a pinned certificate, IPMI through ipmitool); no novad is involved, and no model
// tool reaches any of it (D3). A Redfish BMC's first `check` reads its certificate fingerprint
// without credentials; the owner confirms it (POST …/pin/confirm) before any are sent.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  OOB_ACTIONS,
  enableOobSchema,
  idSchema,
  isSettingKey,
  type OobPowerCycleLink,
} from '@nova/shared';
import {
  OobService,
  type AuditSink,
  type MeshCommandRunner,
  type Notifier,
  type RedfishTransport,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** The setting only POST /api/v1/oob/enable may turn on. */
export const OOB_ENABLED_SETTING = 'devices.oob.enabled';

export interface OobArea extends HubArea {
  service: OobService;
  /**
   * For the boot area (D5): the power-cycle action of the BMC linked to a device, or null. A
   * failed-boot alert offers it as a link; the owner still asks for it and approves it.
   */
  powerCycleFor(accountId: string, deviceId: string): Promise<OobPowerCycleLink | null>;
  useAudit(audit: AuditSink): void;
}

export interface OobDeps {
  /**
   * Write the global setting the way `PATCH /api/v1/settings` does (a managed lock refuses with
   * `policy_denied` `{reason: managed}`): its `settings.changed` carries before, after and
   * `confirmed`, which the ops subscriber audits as the one entry for the change (ADR-096 D3).
   */
  writeSetting: (
    accountId: string,
    key: typeof OOB_ENABLED_SETTING,
    value: boolean,
    opts: { confirmed: boolean },
  ) => Promise<void>;
  audit?: AuditSink;
  notifier?: Notifier;
  /** Tests: a clock, a fake ipmitool, a transport wrapper, shorter timeouts and sweeps. */
  now?: () => Date;
  runner?: MeshCommandRunner;
  transport?: RedfishTransport;
  timeoutMs?: number;
  sweepIntervalMs?: number;
  /** Tests only: the fake BMCs listen on 127.0.0.1. app.ts never sets it. */
  allowLoopbackForTests?: boolean;
}

const params = z.object({ id: idSchema });
const actionParams = z.object({ id: idSchema, action: z.enum(OOB_ACTIONS) });
const actionsQuery = z.object({
  endpointId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function setupOob(ctx: HubContext, deps: OobDeps): Promise<OobArea> {
  const log = ctx.log.child('oob');
  let audit: AuditSink | null = deps.audit ?? null;
  // A key another area has not defined yet reads as off (fail closed).
  const flag = async (key: string): Promise<boolean> =>
    isSettingKey(key) ? (await ctx.setting(key)) === true : false;

  const service = new OobService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    log,
    settings: {
      enabled: () => flag(OOB_ENABLED_SETTING),
      firmwareAllowChanges: () => flag('devices.firmware.allowChanges'),
      firmwareAllowSecurityDegrading: () => flag('devices.firmware.allowSecurityDegrading'),
    },
    // Late-bound: the ops area's audit sink may arrive after setup.
    audit: { append: (r) => (audit ? audit.append(r) : Promise.resolve()) },
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.allowLoopbackForTests ? { allowLoopbackForTests: true } : {}),
  });

  // Cards answered on the Hub run (or end) their action; the card's row decides, not the event.
  const offDecided = ctx.events.bus.subscribe('approval.decided', (e) => {
    const approvalId = typeof e.payload.approvalId === 'string' ? e.payload.approvalId : null;
    if (!approvalId || !e.accountId) return;
    void service
      .onApprovalDecided(e.accountId, approvalId)
      .catch((err: unknown) => log.warn('an out-of-band decision failed', { err }));
  });
  // Turned off by any route (the settings route may turn it off): waiting cards are withdrawn.
  const offSettings = ctx.events.bus.subscribe('settings.changed', (e) => {
    if (e.payload.key !== OOB_ENABLED_SETTING) return;
    void (async () => {
      if (!(await flag(OOB_ENABLED_SETTING))) await service.withdrawOpen();
    })().catch((err: unknown) => log.warn('withdrawing out-of-band cards failed', { err }));
  });
  const sweep = setInterval(() => {
    void service
      .sweepExpired()
      .catch((err: unknown) => log.warn('out-of-band sweep failed', { err }));
  }, deps.sweepIntervalMs ?? 60_000);
  sweep.unref();

  ctx.diagnostics.add('oob', async () => ({
    enabled: await flag(OOB_ENABLED_SETTING),
    ...service.counts(),
  }));

  function register(app: FastifyInstance): void {
    // The settings route never turns out-of-band management on: that needs the consent below.
    app.addHook('preHandler', async (req) => {
      if (req.method !== 'PATCH' || req.routeOptions.url !== '/api/v1/settings') return;
      const body = req.body as { key?: unknown; value?: unknown } | null | undefined;
      if (!body || body.key !== OOB_ENABLED_SETTING || body.value !== true) return;
      const accountId = req.principal?.accountId;
      if (accountId && audit)
        await audit
          .append({
            accountId,
            actor: 'user',
            kind: 'device',
            action: 'device.oob.refuse',
            resource: null,
            decision: 'denied',
            detail: { what: 'enable', reason: 'consent_required', via: 'settings' },
          })
          .catch((err: unknown) => log.warn('out-of-band audit failed', { err }));
      throw new NovaError(
        'policy_denied',
        'Turning on out-of-band management needs your explicit consent: POST /api/v1/oob/enable with {confirm: true}',
        { details: { reason: 'consent_required' } },
      );
    });

    app.get('/api/v1/oob', async (req) => service.status(await ctx.accountOf(req)));

    app.post('/api/v1/oob/enable', async (req) => {
      const accountId = await ctx.accountOf(req);
      const parsed = enableOobSchema.safeParse(req.body ?? {});
      if (!parsed.success)
        throw new NovaError(
          'policy_denied',
          'Out-of-band management can reach and change hardware even when its system is down: confirm with {confirm: true}',
          { details: { reason: 'consent_required' } },
        );
      // The consent above is the confirmation the audit entry records.
      return service.setEnabled(accountId, true, (v) =>
        deps.writeSetting(accountId, OOB_ENABLED_SETTING, v, { confirmed: true }),
      );
    });

    app.post('/api/v1/oob/disable', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.setEnabled(accountId, false, (v) =>
        deps.writeSetting(accountId, OOB_ENABLED_SETTING, v, { confirmed: false }),
      );
    });

    app.get('/api/v1/oob/endpoints', async (req) => ({
      items: await service.list(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/oob/endpoints', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const out = await service.create(accountId, req.body);
      void reply.status(201);
      return out;
    });

    app.get('/api/v1/oob/endpoints/:id', async (req) =>
      service.get(await ctx.accountOf(req), params.parse(req.params).id),
    );

    app.patch('/api/v1/oob/endpoints/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.update(accountId, params.parse(req.params).id, req.body);
    });

    app.delete('/api/v1/oob/endpoints/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await service.remove(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // The owner accepts the certificate fingerprint a first check read; only then do the
    // credentials go to that BMC.
    app.post('/api/v1/oob/endpoints/:id/pin/confirm', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.confirmPin(accountId, params.parse(req.params).id, req.body ?? {});
    });

    // 200 with the finished action (reads, bios.apply); 202 while it waits for its approval.
    app.post('/api/v1/oob/endpoints/:id/actions/:action', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const p = actionParams.parse(req.params);
      const out = await service.act(accountId, p.id, p.action, req.body ?? {});
      if (out.pending) void reply.status(202);
      return { action: out.action };
    });

    app.get('/api/v1/oob/actions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = actionsQuery.parse(req.query);
      return {
        items: await service.listActions(accountId, {
          ...(q.endpointId ? { endpointId: q.endpointId } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
        }),
      };
    });

    app.get('/api/v1/oob/actions/:id', async (req) =>
      service.getAction(await ctx.accountOf(req), params.parse(req.params).id),
    );
  }

  return service.recover().then((n) => {
    if (n) log.warn('out-of-band actions interrupted by a restart were marked failed', { n });
    return {
      service,
      powerCycleFor: (accountId, deviceId) => service.powerCycleFor(accountId, deviceId),
      useAudit(a: AuditSink) {
        audit = a;
      },
      register,
      close() {
        clearInterval(sweep);
        offDecided();
        offSettings();
        return Promise.resolve();
      },
    };
  });
}
