// Network Setup area (FR-136; docs/22 §6; contracts/hub-api.md "Settings, network, diagnostics"):
// the assistant that detects the Hub's network, plans a mesh (Headscale, Tailscale, NetBird or
// WireGuard), applies one consented step at a time, verifies each with a reachability test and
// rolls back. Every route needs the owner's session. Host commands run only while the security
// setting `network.setup.allowSystemChanges` is on. The area gives the network area its mesh
// endpoints and ACL summary, the trust area its mesh certificate source, and registers its undo
// handler with the network change log.
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  idSchema,
  networkSetupRequestSchema,
  networkSetupRollbackSchema,
  type MeshAclSummary,
  type NetworkSetupRequestTransport,
} from '@nova/shared';
import {
  NetworkSetupService,
  ProcessMeshRunner,
  type AuditSink,
  type MeshCommandRunner,
  type MeshEndpointCandidate,
  type NetworkProbe,
  type SetupChangeLog,
  type SetupReachability,
  type SetupRelay,
  type SetupTrust,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface NetworkSetupArea extends HubArea {
  service: NetworkSetupService;
  /** The network area's mesh source: `network.useEndpointSource(setup.endpointSource)`. */
  endpointSource: { transport: 'mesh'; list(): Promise<MeshEndpointCandidate[]> };
  /** The ACL summary for the network diagnostics (FR-139). */
  aclSummary(): Promise<MeshAclSummary>;
  /** The trust area's mesh certificate source (`trust.useMeshCerts(setup.meshCerts)`). */
  meshCerts: {
    request(host: string): Promise<{ certPem: string; keyPem: string; notAfter: string }>;
  };
  useAudit(audit: AuditSink): void;
  useReachability(r: SetupReachability): void;
  useTrust(t: SetupTrust): void;
  useRelay(r: SetupRelay): void;
  useChangeLog(log: SetupChangeLog): void;
  /**
   * Tell the transport of requests the Hub can vouch for (e.g. `relay` for the Relay tunnel, or
   * `local` for a caller that knows it is on the Hub itself); null falls back to the socket.
   */
  useRequestTransport(fn: (req: FastifyRequest) => NetworkSetupRequestTransport | null): void;
}

export interface NetworkSetupDeps {
  audit?: AuditSink;
  now?: () => Date;
  /** Tests: fake CLIs and a fake host. */
  runner?: MeshCommandRunner;
  probe?: Partial<NetworkProbe>;
  /** The port the Hub actually listens on (after a fallback); default the configured one. */
  hubPort?: () => number;
  hubUrl?: (host: string) => string;
  verifyRetries?: number;
  verifyDelayMs?: number;
  detectionTtlMs?: number;
  requestTransport?: (req: FastifyRequest) => NetworkSetupRequestTransport | null;
}

const runParams = z.object({ id: idSchema });

const toolsFileSchema = z
  .object({
    bins: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).optional(),
    baseEnv: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

/**
 * `NOVA_NETWORK_TOOLS_FILE` (JSON `{bins, baseEnv}`) tells the Hub which programs to run for each
 * mesh, firewall and package CLI, by absolute path (the E2E journeys point it at fakes; an
 * operator can point it at CLIs installed outside the system folders). Only whoever starts the
 * Hub can set it. A file that cannot be read or parsed stops the Hub from starting: running the
 * system CLIs instead would be a surprise.
 */
function toolsFromFile(log: HubContext['log']): { runner?: MeshCommandRunner } {
  const path = process.env.NOVA_NETWORK_TOOLS_FILE;
  if (!path) return {};
  const parsed = toolsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  log.warn('network setup runs the programs named in NOVA_NETWORK_TOOLS_FILE', { path });
  return {
    runner: new ProcessMeshRunner({
      ...(parsed.bins ? { bins: parsed.bins } : {}),
      ...(parsed.baseEnv ? { baseEnv: parsed.baseEnv } : {}),
    }),
  };
}

export function setupNetworkSetup(
  ctx: HubContext,
  deps: NetworkSetupDeps = {},
): Promise<NetworkSetupArea> {
  const port = deps.hubPort ?? (() => ctx.config.port);
  const scheme = ctx.config.tls ? 'https' : 'http';
  const service = new NetworkSetupService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    log: ctx.log.child('network-setup'),
    dataDir: ctx.dataDir,
    hubPort: port,
    allowSystemChanges: () => ctx.setting('network.setup.allowSystemChanges'),
    hubUrl:
      deps.hubUrl ?? ((host) => `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port()}`),
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.runner ? { runner: deps.runner } : toolsFromFile(ctx.log)),
    ...(deps.probe ? { probe: deps.probe } : {}),
    ...(deps.verifyRetries !== undefined ? { verifyRetries: deps.verifyRetries } : {}),
    ...(deps.verifyDelayMs !== undefined ? { verifyDelayMs: deps.verifyDelayMs } : {}),
    ...(deps.detectionTtlMs !== undefined ? { detectionTtlMs: deps.detectionTtlMs } : {}),
  });
  let override = deps.requestTransport ?? null;

  /**
   * The transport an owner's request came in on, for the lock-out guard. Only an explicit marker
   * (`useRequestTransport`, e.g. the Relay tunnel's `relay`, or `local` from a caller that knows)
   * is believed. Otherwise the socket's local address decides, except that loopback proves
   * nothing (an SSH tunnel or a proxy on the Hub arrives from 127.0.0.1) and any forwarding
   * header means the real path is somewhere else: both are `unknown`, which the guard treats as
   * possibly any path (fail closed).
   */
  function transportOf(req: FastifyRequest): NetworkSetupRequestTransport {
    const told = override?.(req);
    if (told) return told;
    const h = req.headers;
    if (h['x-forwarded-for'] || h.forwarded || h['x-real-ip'] || h['x-forwarded-host'])
      return 'unknown';
    return service.transportOf(req.socket.localAddress);
  }

  ctx.diagnostics.add('networkSetup', async () => {
    const rows = ctx.db.raw
      .prepare('SELECT status, count(*) AS n FROM network_setup_run GROUP BY status')
      .all() as { status: string; n: number }[];
    return {
      allowSystemChanges: await ctx.setting('network.setup.allowSystemChanges'),
      runs: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    };
  });

  function register(app: FastifyInstance): void {
    app.post('/api/v1/network/setup', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = networkSetupRequestSchema.parse(req.body);
      switch (body.action) {
        case 'detect':
          return { action: 'detect', detection: await service.detect() };
        case 'plan': {
          const run = await service.plan(accountId, body.provider, body.options ?? {});
          void reply.status(201);
          return { action: 'plan', run };
        }
        case 'apply': {
          const out = await service.apply(
            accountId,
            {
              runId: body.runId,
              ...(body.stepId ? { stepId: body.stepId } : {}),
              ...(body.consent ? { consent: body.consent } : {}),
            },
            transportOf(req),
          );
          return { action: 'apply', ...out };
        }
        case 'verify': {
          const out = await service.verify(accountId, body.runId, body.stepId);
          return { action: 'verify', ...out };
        }
      }
    });

    app.get('/api/v1/network/setup/runs', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.listRuns(accountId) };
    });

    app.get('/api/v1/network/setup/runs/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.getRun(accountId, runParams.parse(req.params).id);
    });

    app.post('/api/v1/network/setup/runs/:id/rollback', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = networkSetupRollbackSchema.parse(req.body ?? {});
      return service.rollback(
        accountId,
        runParams.parse(req.params).id,
        body.stepId ? { stepId: body.stepId } : {},
        transportOf(req),
      );
    });

    app.get('/api/v1/network/setup/consents', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.consents(accountId) };
    });

    app.delete('/api/v1/network/setup/consents/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await service.revokeConsent(accountId, runParams.parse(req.params).id);
      return { ok: true };
    });
  }

  return Promise.resolve({
    service,
    endpointSource: { transport: 'mesh', list: () => service.meshEndpoints() },
    aclSummary: () => service.aclSummary(),
    meshCerts: { request: (host) => service.meshCertificate(host) },
    useAudit: (a) => service.useAudit(a),
    useReachability: (r) => service.useReachability(r),
    useTrust: (t) => service.useTrust(t),
    useRelay: (r) => service.useRelay(r),
    useChangeLog: (log) => service.useChangeLog(log),
    useRequestTransport: (fn) => {
      override = fn;
    },
    register,
    close: () => Promise.resolve(),
  });
}
