// M6 computers area (FR-080, FR-102, FR-107, FR-193, FR-195; docs/11, docs/12 §8): agent
// computers, the Hub's sandbox substrate with the egress proxy as its only network route, the
// per-scope network policy shown in Settings > Network, proxy credentials (values write-only)
// and the network decision log. Every route needs a session and validates its input with zod.
//
// Wiring (app.ts): set this area up before the tools area and pass `sandbox: computers.router(
// computers.sandbox)` to setupTools, so every command goes through the proxy and an agent's
// turns run on its computer; register `computers.threadPolicy` with the policy and tools areas
// when the agents area does not give agent threads their roots itself.
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EGRESS_SCOPE_KINDS,
  NovaError,
  computerRestoreSchema,
  computerSnapshotSchema,
  egressCredentialCreateSchema,
  egressCredentialUpdateSchema,
  egressScopeSchema,
  idSchema,
  networkDecisionQuerySchema,
  type EgressView,
  type NetworkDecisionView,
} from '@nova/shared';
import {
  AuditLog,
  CertificateAuthority,
  ComputerService,
  EgressProxyService,
  EgressStore,
  detectSandbox,
  proxyEgress,
  type AuditSink,
  type BrowserFactory,
  type CloudRunner,
  type EgressProxyOptions,
  type LocalHostComputers,
  type ProxySandboxEgress,
  type SandboxClient,
  type ScreenFactory,
  type ThreadPolicySource,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ComputersDeps {
  /** The audit log (the ops area's); a writer of its own otherwise. */
  audit?: AuditSink;
  /** Replace the sandbox substrate (tests); otherwise detected with the egress proxy. */
  sandbox?: SandboxClient;
  /** Proxy options for tests (DNS, address classes, upstream CAs, socket folder). */
  proxy?: Pick<EgressProxyOptions, 'resolve' | 'classify' | 'upstreamCa' | 'socketDir'>;
  /** The cloud runner; the mock runner by default. */
  cloud?: CloudRunner;
}

export interface ComputersArea extends HubArea {
  service: ComputerService;
  proxy: EgressProxyService;
  store: EgressStore;
  /** How substrates open proxy sessions. */
  egress: ProxySandboxEgress;
  /** The Hub's sandbox substrate, network only through the proxy (pass it to the tools area). */
  sandbox: SandboxClient;
  /** Wrap the tools' sandbox so an agent's turns run on its computer. */
  router(base: SandboxClient): SandboxClient;
  /** Agent threads get their computer's folder as root (when the agents area does not). */
  threadPolicy: ThreadPolicySource;
  useBrowser(factory: BrowserFactory | null): void;
  useScreen(factory: ScreenFactory | null): void;
  useLocalHost(provider: LocalHostComputers | null): void;
}

const idParams = z.object({ id: idSchema });
const snapshotParams = z.object({ id: idSchema, snapshotId: idSchema });
const scopeParams = z.object({ kind: z.enum(EGRESS_SCOPE_KINDS), id: idSchema });

interface AuditRow {
  id: string;
  action: string;
  decision: string | null;
  result: string | null;
  detail_json: string | null;
  created_at: string;
}

export async function setupComputers(ctx: HubContext & ComputersDeps): Promise<ComputersArea> {
  const log = ctx.log.child('computers');
  const audit: AuditSink = ctx.audit ?? new AuditLog({ db: ctx.db, events: ctx.events, log });
  let ca: CertificateAuthority | null = null;
  try {
    // The per-Hub inspection CA; its key never leaves the data folder (docs/12 §5).
    ca = CertificateAuthority.loadOrCreate(join(ctx.dataDir, 'egress'));
  } catch (err) {
    log.warn('the egress CA is unavailable: HTTPS cannot be inspected', { err });
  }
  const store = new EgressStore({ db: ctx.db, secrets: ctx.secrets });
  const proxy = new EgressProxyService({
    ca,
    audit,
    credentials: (accountId, ids) => store.credentials(accountId, ids),
    // A Hub running as root runs container sandboxes as nobody, who must reach the socket.
    socketAccess: process.getuid?.() === 0 ? 'everyone' : 'owner',
    log: log.child('egress'),
    ...(ctx.proxy ?? {}),
  });
  const globalPolicy = async () => ({
    mode: await ctx.setting('network.egressMode'),
    allow: await ctx.setting('network.egressAllow'),
    deny: await ctx.setting('network.egressDeny'),
  });
  const egress = proxyEgress({ proxy, store, db: ctx.db, global: globalPolicy });
  const limits = await ctx.setting('computers.limits');
  const microVm = await ctx.setting('computers.microVm');
  const sandbox =
    ctx.sandbox ??
    detectSandbox({
      mode: process.env.NOVA_SANDBOX ?? 'auto',
      deniedPaths: [ctx.dataDir],
      ...(process.env.NOVA_SANDBOX_IMAGE ? { image: process.env.NOVA_SANDBOX_IMAGE } : {}),
      egress,
      // CPU and memory for every command; the wall clock is per computer command, since
      // terminals and dev servers in turns live as long as their turn.
      limits: { cpus: limits.cpus, memoryMb: limits.memoryMb },
      microVm: { enabled: microVm.enabled, runner: null },
    });
  const service = new ComputerService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    sandbox: () => sandbox,
    events: ctx.events,
    audit,
    log,
    agentComputer: () => ctx.setting('computers.agentComputer'),
    limits: () => ctx.setting('computers.limits'),
    ...(ctx.cloud ? { cloud: ctx.cloud } : {}),
  });
  try {
    await service.recover();
    const swept = service.sweep();
    if (swept) log.info('removed files of deleted computers', { count: swept });
  } catch (err) {
    log.warn('computers are unavailable until migration 0022', { err });
  }
  ctx.diagnostics.add('egress', () =>
    Promise.resolve({ httpsInspection: proxy.inspects, sessions: proxy.sessionCount }),
  );

  const audited = async (
    accountId: string,
    kind: 'settings' | 'secret',
    action: string,
    resource: string,
    detail: Record<string, unknown> = {},
  ) => {
    try {
      await audit.append({ accountId, actor: 'user', kind, action, resource, detail });
    } catch (err) {
      log.warn('audit failed', { err, action });
    }
  };

  function decisions(
    accountId: string,
    q: z.infer<typeof networkDecisionQuerySchema>,
  ): { items: NetworkDecisionView[]; nextCursor: string | null } {
    // Newest first, filtered in SQL (host from the detail), paged by the audit sequence.
    const hostFilter = q.host ? q.host.trim().toLowerCase().replace(/\.$/, '') : null;
    const rows = ctx.db.raw
      .prepare(
        `SELECT id, action, decision, result, detail_json, created_at FROM audit_event
         WHERE account_id = ? AND kind = 'network' AND action IN ('egress.request', 'egress.connect')
           AND (? IS NULL OR decision = ?)
           AND (? IS NULL OR json_extract(detail_json, '$.host') = ?)
           AND (? IS NULL OR seq < (SELECT seq FROM audit_event WHERE id = ? AND account_id = ?))
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        accountId,
        q.decision ?? null,
        q.decision ?? null,
        hostFilter,
        hostFilter,
        q.before ?? null,
        q.before ?? null,
        accountId,
        q.limit,
      ) as unknown as AuditRow[];
    const out: NetworkDecisionView[] = [];
    for (const r of rows) {
      let d: Record<string, unknown>;
      try {
        d = r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : {};
      } catch {
        d = {};
      }
      const host = typeof d.host === 'string' ? d.host : null;
      const scope = d.scope as { kind?: unknown; id?: unknown } | undefined;
      out.push({
        id: r.id,
        createdAt: r.created_at,
        decision: r.decision === 'deny' ? 'deny' : 'allow',
        cause: typeof d.cause === 'string' ? (d.cause as NetworkDecisionView['cause']) : null,
        method: typeof d.method === 'string' ? d.method : null,
        host,
        port: typeof d.port === 'number' ? d.port : null,
        scope:
          typeof scope?.kind === 'string' && typeof scope.id === 'string'
            ? { kind: scope.kind, id: scope.id }
            : null,
        addressClass: typeof d.addressClass === 'string' ? d.addressClass : null,
        mode: typeof d.mode === 'string' ? (d.mode as NetworkDecisionView['mode']) : null,
        status: typeof d.status === 'number' ? d.status : null,
        inspected: d.inspected === true,
        bytesIn: typeof d.bytesIn === 'number' ? d.bytesIn : 0,
        bytesOut: typeof d.bytesOut === 'number' ? d.bytesOut : 0,
      });
    }
    const last = rows.at(-1);
    return { items: out, nextCursor: rows.length === q.limit && last ? last.id : null };
  }

  function register(app: FastifyInstance): void {
    // ---- computers (FR-080) ----
    app.get('/api/v1/computers', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await service.list(accountId) };
    });
    app.get('/api/v1/computers/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.view(accountId, idParams.parse(req.params).id);
    });
    app.get('/api/v1/computers/:id/snapshots', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.snapshots(accountId, idParams.parse(req.params).id) };
    });
    app.post('/api/v1/computers/:id/snapshots', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = computerSnapshotSchema.parse(req.body ?? {});
      const snap = await service.snapshot(accountId, id, body.label ?? null);
      return reply.status(201).send(snap);
    });
    app.delete('/api/v1/computers/:id/snapshots/:snapshotId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, snapshotId } = snapshotParams.parse(req.params);
      if (!(await service.deleteSnapshot(accountId, id, snapshotId)))
        throw new NovaError('not_found', 'no such snapshot');
      return { ok: true };
    });
    app.post('/api/v1/computers/:id/restore', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = computerRestoreSchema.parse(req.body ?? {});
      return service.restore(accountId, id, body.snapshotId);
    });
    app.post('/api/v1/computers/:id/stop', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.stop(accountId, idParams.parse(req.params).id);
    });

    // ---- egress policy (Settings > Network, FR-102, FR-193) ----
    app.get('/api/v1/egress', async (req): Promise<EgressView> => {
      const accountId = await ctx.accountOf(req);
      return {
        global: await globalPolicy(),
        scopes: store.listScopes(accountId),
        inspection: { https: proxy.inspects, caCertPem: proxy.caCertPem },
      };
    });
    app.get('/api/v1/egress/ca.pem', async (req, reply) => {
      await ctx.accountOf(req);
      const pem = proxy.caCertPem;
      if (!pem) throw new NovaError('not_found', 'HTTPS inspection is not set up on this Hub');
      return reply.type('application/x-pem-file').send(pem);
    });
    app.put('/api/v1/egress/scopes/:kind/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { kind, id } = scopeParams.parse(req.params);
      const body = egressScopeSchema.parse(req.body ?? {});
      const v = await store.putScope(accountId, kind, id, body);
      await audited(accountId, 'settings', 'egress.scope.set', `${kind}:${id}`, {
        mode: v.mode,
        allow: v.allow.length,
        deny: v.deny.length,
        hooks: v.hooks.length,
        allowLocalBinding: v.allowLocalBinding,
      });
      await ctx.events.emit({
        name: 'egress.policy.changed',
        accountId,
        payload: { scope: { kind, id } },
      });
      return v;
    });
    app.delete('/api/v1/egress/scopes/:kind/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { kind, id } = scopeParams.parse(req.params);
      if (!(await store.deleteScope(accountId, kind, id)))
        throw new NovaError('not_found', 'no network policy for this scope');
      await audited(accountId, 'settings', 'egress.scope.delete', `${kind}:${id}`);
      await ctx.events.emit({
        name: 'egress.policy.changed',
        accountId,
        payload: { scope: { kind, id } },
      });
      return { ok: true };
    });

    // ---- credentials the proxy injects (ADR-063); values are write-only ----
    app.get('/api/v1/egress/credentials', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: store.listCredentials(accountId) };
    });
    app.post('/api/v1/egress/credentials', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = egressCredentialCreateSchema.parse(req.body ?? {});
      const v = await store.createCredential(accountId, body);
      await audited(accountId, 'secret', 'egress.credential.create', v.secretRef, {
        hosts: v.hosts,
        scheme: v.scheme,
      });
      return reply.status(201).send(v);
    });
    app.patch('/api/v1/egress/credentials/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const body = egressCredentialUpdateSchema.parse(req.body ?? {});
      if (!Object.keys(body).length) throw new NovaError('validation', 'nothing to update');
      const v = await store.updateCredential(accountId, id, body);
      await audited(accountId, 'secret', 'egress.credential.update', v.secretRef, {
        fields: Object.keys(body).filter((k) => k !== 'value'),
        valueChanged: body.value !== undefined,
      });
      return v;
    });
    app.delete('/api/v1/egress/credentials/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = idParams.parse(req.params);
      const cur = store.getCredential(accountId, id);
      if (!cur || !(await store.deleteCredential(accountId, id)))
        throw new NovaError('not_found', 'no such credential');
      await audited(accountId, 'secret', 'egress.credential.delete', cur.secretRef);
      return { ok: true };
    });

    // ---- the network decision log (every proxy decision, docs/12 §8) ----
    app.get('/api/v1/egress/decisions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = networkDecisionQuerySchema.parse(req.query ?? {});
      return decisions(accountId, q);
    });
  }

  return {
    service,
    proxy,
    store,
    egress,
    sandbox,
    router: (base) => service.sandboxRouter(base),
    threadPolicy: service.threadPolicy(),
    useBrowser: (f) => service.useBrowser(f),
    useScreen: (f) => service.useScreen(f),
    useLocalHost: (p) => service.useLocalHost(p),
    register,
    close: async () => {
      await service.close();
      await proxy.close();
    },
  };
}
