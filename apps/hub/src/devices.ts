// Devices area (docs/23; contracts/hub-api.md §1 "Auth & devices", §3): devices running `novad`.
// Owner routes under /api/v1/devices need a session: the registry and enrollment tokens, overrides
// and policy (FR-142, FR-150), capabilities and version gating (FR-148), modules and services
// (FR-141, FR-145), power and Wake-on-LAN (FR-144), signed updates (FR-148), device files with
// folder grants, access requests and staged writes (FR-210), local MCP pass-through, and agents'
// connected computers (FR-081) with the agent's tools for their files. The /agent/v1 routes are
// novad's: register authenticates with the one-use token in its body, heartbeat and capabilities
// with the device credential, which they check themselves; a device credential never
// authenticates a user route.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEVICE_MODULE_ACTIONS,
  DEVICE_SERVICE_ACTIONS,
  NovaError,
  connectAgentDeviceSchema,
  deviceAccessRequestSchema,
  deviceGrantSchema,
  deviceGranteeSchema,
  deviceMcpCallSchema,
  devicePathSchema,
  devicePowerSchema,
  enrollDeviceSchema,
  idSchema,
  pushDeviceUpdatesSchema,
  stageDeviceWriteSchema,
  updateDeviceSchema,
  type DeviceGrantee,
} from '@nova/shared';
import {
  DeviceComputerProvider,
  DeviceService,
  deviceEnvProvider,
  deviceEnvironment,
  deviceToolSource,
  type AuditSink,
  type DeviceAgentThreadResolver,
  type DeviceEnvironment,
  type DeviceTransport,
  type Notifier,
  type ToolSourceProvider,
  type WolTarget,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import type { NovadRouteHooks } from './node-routes.ts';

export interface DevicesArea extends HubArea {
  service: DeviceService;
  /** `local_host` computers for the computers area: an agent's connected device (FR-081). */
  computers: DeviceComputerProvider;
  /**
   * An agent's tools for the files of its connected computer (`device.files.*`, FR-081, FR-210),
   * for the tools area's sources; listed in its threads once `useAgentThreads` is bound.
   */
  tools: ToolSourceProvider;
  /** A Code session's `device` environment (FR-062), for the code area. */
  environment(input: {
    accountId: string;
    deviceId: string;
    sessionId: string;
    threadId?: string;
  }): DeviceEnvironment;
  /** The code area's `EnvDeviceProvider` (`code.useDevices(devices.codeEnvironments)`). */
  codeEnvironments: ReturnType<typeof deviceEnvProvider>;
  /** Add Device for novad roles, listing by role and revoke, for `registerNodeRoutes`. */
  nodeRoutes: NovadRouteHooks;
  useAudit(audit: AuditSink): void;
  useNotifier(notifier: Notifier): void;
  /** Whether an agent exists (the agents area); connections accept any agent id without it. */
  useAgents(exists: (accountId: string, agentId: string) => Promise<boolean>): void;
  /** The agent a thread belongs to (the agents area), for the device tools' listing and calls. */
  useAgentThreads(resolver: DeviceAgentThreadResolver): void;
  /**
   * The computers area registers a `local_host` computer row when an agent connects a device;
   * `computers` above serves it (`useLocalHost(devices.computers)`).
   */
  useComputers(c: {
    ensureLocalHost(
      accountId: string,
      input: { deviceId: string; agentId?: string | null },
    ): Promise<unknown>;
  }): void;
}

export interface DevicesDeps {
  audit?: AuditSink;
  notifier?: Notifier;
  /** Tests: a clock, a transport to devices, where magic packets go, shorter heartbeats. */
  now?: () => Date;
  transport?: DeviceTransport;
  wol?: WolTarget & { send?: (mac: string, target: WolTarget) => Promise<void> };
  heartbeatIntervalMs?: number;
  /** The update signing key devices pin at enrollment (FR-148). */
  updateKey?: () => Promise<string | null>;
}

const params = z.object({ id: idSchema });
const stagedParams = z.object({ id: idSchema, sid: idSchema });
const grantParams = z.object({ id: idSchema, grantId: idSchema });
const requestParams = z.object({ id: idSchema, rid: idSchema });
const moduleParams = z.object({
  id: idSchema,
  name: z.string().min(1).max(50),
  action: z.enum(DEVICE_MODULE_ACTIONS),
});
const serviceParams = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  action: z.enum(DEVICE_SERVICE_ACTIONS),
});
const pathQuery = z.object({ path: devicePathSchema });
const readQuery = z.object({
  path: devicePathSchema,
  maxBytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024)
    .optional(),
});
const stagedQuery = z.object({
  status: z.enum(['staged', 'committed', 'discarded', 'conflict', 'expired', 'failed']).optional(),
  sessionRef: z.string().min(1).max(200).optional(),
});
const connectionsQuery = z.object({ agentId: idSchema.optional(), deviceId: idSchema.optional() });
const granteeQuery = z.object({
  granteeKind: deviceGranteeSchema.shape.kind.optional(),
  granteeId: deviceGranteeSchema.shape.id.optional(),
});

function credential(req: FastifyRequest): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new NovaError('token_required', 'a device credential is required');
  return token;
}

function hubUrlOf(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

export function setupDevices(ctx: HubContext, deps: DevicesDeps = {}): Promise<DevicesArea> {
  const service = new DeviceService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    log: ctx.log.child('devices'),
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.wol ? { wol: deps.wol } : {}),
    ...(deps.heartbeatIntervalMs ? { heartbeatIntervalMs: deps.heartbeatIntervalMs } : {}),
    ...(deps.updateKey ? { updateKey: deps.updateKey } : {}),
    settings: {
      minVersions: () => ctx.setting('devices.minNovadVersions'),
      wakesPerHour: () => ctx.setting('devices.wakesPerHour'),
    },
  });
  const computers = new DeviceComputerProvider(service);
  let audit: AuditSink | null = deps.audit ?? null;
  let agentThreads: DeviceAgentThreadResolver | null = null;
  const tools = deviceToolSource({
    service,
    agentOf: () => agentThreads,
    audit: () => audit,
  });
  service.start();

  // A folder-access card answered on the Hub reaches the device (FR-210). Device-side answers
  // close the card themselves and are skipped here.
  const off = ctx.events.bus.subscribe('approval.decided', (e) => {
    const p = e.payload;
    const approvalId = typeof p.approvalId === 'string' ? p.approvalId : null;
    const decidedBy = typeof p.decidedBy === 'string' ? p.decidedBy : '';
    if (!approvalId || !e.accountId || decidedBy.startsWith('device:')) return;
    void service
      .onApprovalDecided(e.accountId, approvalId, typeof p.decision === 'string' ? p.decision : '')
      .catch((err: unknown) => ctx.log.warn('passing an access decision failed', { err }));
  });

  ctx.diagnostics.add('devices', () => {
    const rows = ctx.db.raw
      .prepare(
        `SELECT d.status AS status, count(*) AS n FROM device d
         JOIN device_management m ON m.device_id = d.id GROUP BY d.status`,
      )
      .all() as { status: string; n: number }[];
    return Promise.resolve(Object.fromEntries(rows.map((r) => [r.status, r.n])));
  });

  const user = (accountId: string): DeviceGrantee => ({ kind: 'user', id: accountId });

  const nodeRoutes: NovadRouteHooks = {
    async createEnrollToken(accountId, role, hubUrl) {
      const { roles } = enrollDeviceSchema.parse({ roles: [role] });
      return service.createEnrollToken(accountId, roles, hubUrl);
    },
    async list(accountId, role) {
      return (await service.list(accountId)).filter((d) => d.roles.includes(role));
    },
    revoke: (accountId, deviceId) => service.revoke(accountId, deviceId),
  };

  function register(app: FastifyInstance): void {
    // ---- novad → Hub (no session; checked here) --------------------------------------------
    app.post('/agent/v1/register', async (req, reply) => {
      const out = await service.register(req.body);
      void reply.status(201);
      return out;
    });

    app.post('/agent/v1/heartbeat', async (req) => service.heartbeat(credential(req), req.body));

    app.post('/agent/v1/capabilities', async (req) => {
      await service.updateCapabilities(credential(req), req.body);
      return { ok: true };
    });

    // ---- the registry ----------------------------------------------------------------------
    app.get('/api/v1/devices/novad', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.list(accountId) };
    });

    app.post('/api/v1/devices/novad/enroll', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = enrollDeviceSchema.parse(req.body ?? {});
      const out = await service.createEnrollToken(accountId, body.roles, hubUrlOf(req));
      // A one-use credential: no cache and no idempotent replay may keep it.
      void reply.header('cache-control', 'no-store').status(201);
      return out;
    });

    app.get('/api/v1/devices/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.get(accountId, params.parse(req.params).id);
    });

    app.patch('/api/v1/devices/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      return service.update(accountId, id, updateDeviceSchema.parse(req.body));
    });

    app.get('/api/v1/devices/:id/capabilities', async (req) => {
      const accountId = await ctx.accountOf(req);
      const view = await service.get(accountId, params.parse(req.params).id);
      return {
        novadVersion: view.novadVersion,
        updateRequired: view.updateRequired,
        items: view.capabilities,
        document: view.capability,
      };
    });

    // ---- modules, services, power, wake ----------------------------------------------------
    app.post('/api/v1/devices/:id/modules/:name/:action', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = moduleParams.parse(req.params);
      return { module: await service.moduleAction(accountId, p.id, p.name, p.action) };
    });

    app.post('/api/v1/devices/:id/services/:name/:action', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = serviceParams.parse(req.params);
      return { service: await service.serviceAction(accountId, p.id, p.name, p.action) };
    });

    app.get('/api/v1/devices/:id/power', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.power(accountId, params.parse(req.params).id, { action: 'status' });
    });

    app.post('/api/v1/devices/:id/power', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.power(
        accountId,
        params.parse(req.params).id,
        devicePowerSchema.parse(req.body),
      );
    });

    app.post('/api/v1/devices/:id/wake', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.wake(accountId, params.parse(req.params).id);
    });

    // ---- updates ---------------------------------------------------------------------------
    app.get('/api/v1/devices/:id/updates', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.updates(accountId, params.parse(req.params).id) };
    });

    app.post('/api/v1/devices/:id/updates', { bodyLimit: 96 * 1024 * 1024 }, async (req) => {
      const accountId = await ctx.accountOf(req);
      const { bundles } = pushDeviceUpdatesSchema.parse(req.body);
      return { items: await service.pushUpdates(accountId, params.parse(req.params).id, bundles) };
    });

    // ---- files, grants and access requests (FR-210) -----------------------------------------
    app.get('/api/v1/devices/:id/files', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { path } = pathQuery.parse(req.query);
      return service.listFiles(accountId, params.parse(req.params).id, user(accountId), path);
    });

    app.get('/api/v1/devices/:id/files/content', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = readQuery.parse(req.query);
      return service.readFile(
        accountId,
        params.parse(req.params).id,
        user(accountId),
        q.path,
        q.maxBytes,
      );
    });

    app.get('/api/v1/devices/:id/grants', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.grants(accountId, params.parse(req.params).id) };
    });

    app.post('/api/v1/devices/:id/grants', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = deviceGrantSchema.parse(req.body);
      const out = await service.grant(
        accountId,
        params.parse(req.params).id,
        body.kind === 'folder'
          ? { grantee: body.grantee, kind: 'folder', target: body.path, access: body.access }
          : { grantee: body.grantee, kind: 'mcp', target: body.server, access: 'call' },
      );
      void reply.status(201);
      return out;
    });

    app.delete('/api/v1/devices/:id/grants/:grantId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = grantParams.parse(req.params);
      await service.revokeGrant(accountId, p.id, p.grantId);
      return { ok: true };
    });

    app.post('/api/v1/devices/:id/access-requests', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = deviceAccessRequestSchema.parse(req.body);
      const out = await service.requestAccess(
        accountId,
        params.parse(req.params).id,
        body.grantee ?? user(accountId),
        { path: body.path, access: body.access, ...(body.reason ? { reason: body.reason } : {}) },
      );
      void reply.status(201);
      return out;
    });

    app.get('/api/v1/devices/:id/access-requests/:rid', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = requestParams.parse(req.params);
      const out = await service.accessRequest(accountId, p.rid);
      if (out.deviceId !== p.id) throw new NovaError('not_found', 'access request not found');
      return out;
    });

    // ---- staged writes ---------------------------------------------------------------------
    app.get('/api/v1/devices/:id/staged', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = stagedQuery.parse(req.query);
      return { items: await service.stagedWrites(accountId, params.parse(req.params).id, q) };
    });

    app.post('/api/v1/devices/:id/staged', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = stageDeviceWriteSchema.parse(req.body);
      const contentBase64 =
        body.contentBase64 ?? Buffer.from(body.content ?? '', 'utf8').toString('base64');
      const out = await service.stage(
        accountId,
        params.parse(req.params).id,
        body.grantee ?? user(accountId),
        {
          path: body.path,
          contentBase64,
          ...(body.baseSha256 ? { baseSha256: body.baseSha256 } : {}),
          ...(body.createDirs !== undefined ? { createDirs: body.createDirs } : {}),
          ...(body.sessionRef ? { sessionRef: body.sessionRef } : {}),
        },
      );
      void reply.status(201);
      return out;
    });

    const staged = async (req: FastifyRequest) => {
      const accountId = await ctx.accountOf(req);
      const p = stagedParams.parse(req.params);
      const view = await service.stagedWrite(accountId, p.sid);
      if (view.deviceId !== p.id) throw new NovaError('not_found', 'staged write not found');
      return { accountId, view };
    };

    app.get('/api/v1/devices/:id/staged/:sid', async (req) => (await staged(req)).view);

    app.post('/api/v1/devices/:id/staged/:sid/commit', async (req) => {
      const { accountId, view } = await staged(req);
      return service.commit(accountId, view.id);
    });

    app.post('/api/v1/devices/:id/staged/:sid/discard', async (req) => {
      const { accountId, view } = await staged(req);
      return service.discard(accountId, view.id);
    });

    // ---- local MCP pass-through ------------------------------------------------------------
    app.get('/api/v1/devices/:id/mcp', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = granteeQuery.parse(req.query);
      const grantee =
        q.granteeKind && q.granteeId ? { kind: q.granteeKind, id: q.granteeId } : user(accountId);
      return service.mcpList(accountId, params.parse(req.params).id, grantee);
    });

    app.post('/api/v1/devices/:id/mcp/call', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = deviceMcpCallSchema.parse(req.body);
      return service.mcpCall(
        accountId,
        params.parse(req.params).id,
        body.grantee ?? user(accountId),
        {
          server: body.server,
          tool: body.tool,
          arguments: body.arguments,
        },
      );
    });

    // ---- agents' connected computers (FR-081) ------------------------------------------------
    app.get('/api/v1/devices/connections', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = connectionsQuery.parse(req.query);
      return { items: await service.connections(accountId, q) };
    });

    app.post('/api/v1/devices/connections', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = connectAgentDeviceSchema.parse(req.body);
      const out = await service.connect(accountId, body);
      void reply.status(201);
      return out;
    });

    app.delete('/api/v1/devices/connections/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.disconnect(accountId, params.parse(req.params).id);
    });
  }

  return Promise.resolve({
    service,
    computers,
    tools,
    environment: (input) => deviceEnvironment(service, input),
    codeEnvironments: deviceEnvProvider(service),
    nodeRoutes,
    useAudit: (a) => {
      audit = a;
      service.useAudit(a);
    },
    useNotifier: (n) => service.useNotifier(n),
    useAgents: (fn) => service.useAgents(fn),
    useAgentThreads: (resolver) => {
      agentThreads = resolver;
    },
    useComputers: (c) => {
      service.onConnectionChanged(async (accountId, conn) => {
        if (conn.status === 'active')
          await c.ensureLocalHost(accountId, { deviceId: conn.deviceId, agentId: conn.agentId });
      });
    },
    register,
    close: () => {
      off();
      service.stop();
      return Promise.resolve();
    },
  });
}
