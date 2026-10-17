// Trust area (FR-134, docs/22 §5; contracts/hub-api.md "Settings, network, diagnostics"): the
// Hub's identity key, the Hub local CA, the Hub's TLS leaf, mesh certificates and device
// certificates. Owner routes need a session: `GET/PATCH /api/v1/trust` and `POST
// /api/v1/trust/renew`. Public routes hand out public information only: the CA's root
// certificate (`ca.pem`, `ca.crt`) so a device can install it, and the Hub's signed identity
// statement native shells check against the key they pinned.
//
// The trust mode is the `trust.*` settings. A change through this area or the generic settings
// route is audited as `trust.change`, emits `trust.changed` and goes into the network change log
// for rollback; the listener applies a new mode at the next start (main.ts).
import { hostname as osHostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  NovaError,
  identityQuerySchema,
  trustPatchSchema,
  trustRenewSchema,
  type TrustMeshCertView,
  type TrustMode,
  type TrustPatch,
  type TrustServingView,
  type TrustSummary,
} from '@nova/shared';
import {
  TrustService,
  pemToDer,
  type AuditSink,
  type DeviceCertificateCheck,
  type DeviceCertificateRequest,
  type HubIdentityHandle,
  type MeshCertSource,
  type TlsMaterial,
} from '@nova/core';
import { schema } from '@nova/storage';
import type { HubConfig } from './config.ts';
import type { HubArea, HubContext } from './hub-context.ts';

/** The network change log (agent C's NetworkChangeLog satisfies this). */
export interface TrustChangeLog {
  record(input: {
    kind: string;
    summary: string;
    undo: Record<string, unknown>;
    accountId?: string | null;
    actor?: string;
  }): Promise<unknown>;
  registerUndo(kind: string, handler: (undo: Record<string, unknown>) => Promise<void>): unknown;
}

/** What main.ts serves HTTPS with. */
export interface HubTlsSource {
  /** Null when the trust mode serves no certificate (then the listener stays plain HTTP). */
  material(): Promise<TlsMaterial | null>;
  /** A renewal or a new mesh certificate: read `material()` again. */
  onChange(listener: () => void): () => void;
  reportServing(serving: TrustServingView): void;
}

export interface TrustArea extends HubArea {
  service: TrustService;
  /** For `useHubIdentity` (add device) and the agent-dist manifest signature. */
  identity: HubIdentityHandle;
  /** The fields `GET /api/v1/hello` adds (null only if the vault could not give the key). */
  helloFields(): { hubFingerprint: string | null; hubPublicKey: string | null };
  /** For `useCertIssuer` (add device): null unless the trust mode is `local-ca`. */
  certIssuer: {
    issueDeviceCertificate(
      input: DeviceCertificateRequest,
    ): Promise<{ certificatePem: string; expiresAt: string } | null>;
  };
  /** Device revocation revokes the device's certificates (docs/22 §4.5). */
  revokeDevice(deviceId: string): Promise<number>;
  /** M7 mutual TLS checks client certificates here. */
  verifyDeviceCertificate(pem: string): DeviceCertificateCheck;
  tls: HubTlsSource;
  /** For network diagnostics (`useTrustSummary`). */
  trustSummary(): Promise<TrustSummary>;
  /** For the network setup assistant (`useTrust`). */
  requestMeshCert(host: string): Promise<TrustMeshCertView>;
  ensureLocalCa(): Promise<{ fingerprint: string; certPem: string }>;
  /** The mesh adapter that runs `tailscale cert` (network setup). */
  useMeshCerts(source: MeshCertSource): void;
  useChangeLog(log: TrustChangeLog): void;
  useAudit(audit: AuditSink): void;
  /** More names the Hub answers to (the network area's mDNS name and public address). */
  useHostnames(names: () => Promise<string[]>): void;
}

export interface TrustDeps {
  audit?: AuditSink;
  now?: () => Date;
  /** Tests: this machine's host name and interfaces. */
  hostname?: () => string;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** How often certificates are checked for renewal (default 1 hour). */
  maintainIntervalMs?: number;
}

const KEYS = {
  mode: 'trust.mode',
  meshCerts: 'trust.meshCerts',
  pinNativeShells: 'trust.pinNativeShells',
} as const;

interface TrustState {
  mode: TrustMode;
  meshCerts: boolean;
  pinNativeShells: boolean;
}

/** The names and addresses this Hub answers to (FR-134: the leaf's SANs). */
export function hubNames(
  config: Pick<HubConfig, 'host' | 'allowedOrigins'>,
  host: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  const out = new Set<string>(['localhost']);
  if (config.host !== '0.0.0.0' && config.host !== '::')
    out.add(config.host.replace(/^\[|\]$/g, ''));
  for (const o of config.allowedOrigins) {
    try {
      out.add(new URL(o).hostname.replace(/^\[|\]$/g, ''));
    } catch {
      // not a URL: nothing to add
    }
  }
  const label = host
    .toLowerCase()
    .split('.')[0]!
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // The bare host name is a single label: never certified, since it could be a top-level domain
  // (`dev`); its `.local` name is.
  if (label) out.add(`${label}.local`);
  if (host.includes('.')) out.add(host.toLowerCase());
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      // A scoped IPv6 link-local address cannot go in a certificate.
      if (a.family === 'IPv6' && a.address.toLowerCase().startsWith('fe80')) continue;
      out.add(a.address);
    }
  }
  return [...out];
}

function describe(s: TrustState): string {
  const mode =
    s.mode === 'local-ca' ? 'local CA' : s.mode === 'mesh' ? 'mesh certificates' : 'none';
  return `${mode}${s.mode === 'local-ca' && s.meshCerts ? ' + mesh certificates' : ''}${
    s.pinNativeShells ? '' : ', pinning off'
  }`;
}

function sameState(a: TrustState, b: TrustState): boolean {
  return (
    a.mode === b.mode && a.meshCerts === b.meshCerts && a.pinNativeShells === b.pinNativeShells
  );
}

export async function setupTrust(ctx: HubContext, deps: TrustDeps = {}): Promise<TrustArea> {
  let extraNames: (() => Promise<string[]>) | null = null;
  let changeLog: TrustChangeLog | null = null;
  const ownerAccount = (): Promise<string | null> => {
    const row = ctx.db.raw
      .prepare("SELECT id FROM account WHERE kind = 'local' AND deleted_at IS NULL LIMIT 1")
      .get() as { id: string } | undefined;
    return Promise.resolve(row?.id ?? null);
  };
  const service = new TrustService({
    db: ctx.db,
    secrets: ctx.secrets,
    events: ctx.events,
    log: ctx.log.child('trust'),
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ownerAccount,
    settings: {
      mode: () => ctx.setting(KEYS.mode),
      meshCerts: () => ctx.setting(KEYS.meshCerts),
      pinNativeShells: () => ctx.setting(KEYS.pinNativeShells),
    },
    names: async () => [
      ...hubNames(
        ctx.config,
        (deps.hostname ?? osHostname)(),
        (deps.interfaces ?? networkInterfaces)(),
      ),
      ...(extraNames ? await extraNames() : []),
    ],
  });
  // A vault that cannot give the key must not stop the Hub (docs/22 §9: never lock the owner
  // out): the key is loaded again on first use, and hello leaves the fields null meanwhile.
  await service.start().catch((err: unknown) => {
    ctx.log.error('the Hub identity key could not be loaded', { err });
  });

  const state = async (): Promise<TrustState> => ({
    mode: await ctx.setting(KEYS.mode),
    meshCerts: await ctx.setting(KEYS.meshCerts),
    pinNativeShells: await ctx.setting(KEYS.pinNativeShells),
  });
  let last = await state();
  // Set while a rollback writes the previous values back: audited, not logged as a new change.
  let rollingBack = false;
  let chain: Promise<unknown> = Promise.resolve();
  let auditSink: AuditSink | null = deps.audit ?? null;

  /** Compare the settings with the last ones seen; audit, log and announce a change. */
  // `actor` is the event's: `user`, `system` or `agent:<id>`.
  const reconcile = (who: { actor: string; accountId: string | null }) => {
    const run = async () => {
      const now = await state();
      const prev = last;
      last = now;
      if (sameState(prev, now)) return;
      const accountId = who.accountId ?? (await ownerAccount());
      const via = rollingBack ? 'rollback' : 'settings';
      const audit = auditSink;
      if (audit && accountId)
        await audit
          .append({
            accountId,
            actor: who.actor,
            kind: 'network',
            action: 'trust.change',
            resource: 'trust',
            detail: { from: prev, to: now, via },
          })
          .catch((err: unknown) => ctx.log.warn('trust audit failed', { err }));
      if (changeLog && !rollingBack)
        await changeLog
          .record({
            kind: 'trust.mode',
            summary: `Trust: ${describe(prev)} → ${describe(now)}`,
            undo: { previous: prev },
            accountId,
            actor: who.actor,
          })
          .catch((err: unknown) => ctx.log.warn('recording the trust change failed', { err }));
      const view = await service.view();
      await ctx.events.emit({
        name: 'trust.changed',
        actor: who.actor,
        ...(accountId ? { accountId } : {}),
        payload: {
          reason: 'mode',
          mode: now.mode,
          meshCerts: now.meshCerts,
          pinNativeShells: now.pinNativeShells,
          previous: prev,
          restartRequired: view.restartRequired,
        },
      });
      // The CA exists as soon as the owner picks it, so devices can install the root before the
      // restart that turns HTTPS on.
      if (now.mode === 'local-ca' && prev.mode !== 'local-ca')
        await service
          .ensureLeaf({ who: { actor: who.actor === 'user' ? 'user' : 'system', accountId } })
          .catch((err: unknown) => ctx.log.warn('preparing the local CA failed', { err }));
      service.refreshTls();
    };
    const next = chain.then(run, run);
    chain = next.catch((err: unknown) => ctx.log.warn('trust reconcile failed', { err }));
    return next;
  };

  const off = ctx.events.bus.subscribe('settings.changed', (e) => {
    const key = typeof e.payload.key === 'string' ? e.payload.key : '';
    if (!key.startsWith('trust.')) return;
    void reconcile({ actor: e.actor, accountId: e.accountId ?? null }).catch(() => undefined);
  });

  /** Store the values as global settings and announce them, like the settings route does. */
  async function write(
    patch: TrustPatch,
    who: { actor: 'user' | 'system'; accountId: string | null },
  ): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [
      keyof TrustPatch,
      unknown,
    ][];
    const at = new Date().toISOString();
    const { setting } = schema;
    await ctx.db.transaction(async () => {
      for (const [field, value] of entries) {
        const key = KEYS[field];
        await ctx.db.orm
          .delete(setting)
          .where(
            and(eq(setting.key, key), eq(setting.scopeKind, 'global'), eq(setting.scopeRef, '')),
          );
        await ctx.db.orm.insert(setting).values({
          key,
          scopeKind: 'global',
          scopeRef: '',
          valueJson: JSON.stringify(value),
          updatedAt: at,
        });
      }
      // A value managed policy sets does not change: refuse (and roll back) instead of storing
      // a row that would surprise the owner once the policy goes.
      for (const [field, value] of entries)
        if ((await ctx.setting(KEYS[field])) !== value)
          throw new NovaError('policy_denied', `${KEYS[field]} is managed by your organization`, {
            details: { reason: 'managed' },
          });
    });
    for (const [field] of entries)
      await ctx.events.emit({
        name: 'settings.changed',
        actor: who.actor,
        ...(who.accountId ? { accountId: who.accountId } : {}),
        payload: { key: KEYS[field], scope: 'global' },
      });
    await reconcile(who);
  }

  const interval = setInterval(
    () => {
      void service.maintain().catch((err: unknown) => ctx.log.warn('trust upkeep failed', { err }));
    },
    deps.maintainIntervalMs ?? 60 * 60_000,
  );
  interval.unref();

  ctx.diagnostics.add('trust', () => service.summary());

  const area: TrustArea = {
    service,
    identity: service.identity,
    helloFields: () =>
      service.identity.loaded
        ? service.identity.helloFields()
        : { hubFingerprint: null, hubPublicKey: null },
    certIssuer: {
      issueDeviceCertificate: async (input) => {
        const issued = await service.issueDeviceCertificate(input);
        return issued
          ? { certificatePem: issued.certificatePem, expiresAt: issued.expiresAt }
          : null;
      },
    },
    revokeDevice: (deviceId) => service.revokeDevice(deviceId),
    verifyDeviceCertificate: (pem) => service.verifyDeviceCertificate(pem),
    tls: {
      material: () => service.tlsMaterial(),
      onChange: (listener) => service.onTlsChange(listener),
      reportServing: (serving) => service.reportServing(serving),
    },
    trustSummary: () => service.summary(),
    requestMeshCert: (host) => service.requestMeshCert(host),
    ensureLocalCa: async () => {
      await service.ensureLeaf();
      const certPem = service.caCertificate() ?? '';
      return { fingerprint: (await service.summary()).caFingerprint ?? '', certPem };
    },
    useMeshCerts: (source) => service.useMeshCerts(source),
    useChangeLog: (log) => {
      changeLog = log;
      log.registerUndo('trust.mode', async (undo) => {
        const previous = (undo as { previous?: Partial<TrustState> }).previous ?? {};
        const parsed = trustPatchSchema.safeParse({
          ...(previous.mode !== undefined ? { mode: previous.mode } : {}),
          ...(previous.meshCerts !== undefined ? { meshCerts: previous.meshCerts } : {}),
          ...(previous.pinNativeShells !== undefined
            ? { pinNativeShells: previous.pinNativeShells }
            : {}),
        });
        if (!parsed.success) throw new NovaError('validation', 'the trust change cannot be undone');
        rollingBack = true;
        try {
          await write(parsed.data, { actor: 'user', accountId: await ownerAccount() });
        } finally {
          rollingBack = false;
        }
      });
    },
    useAudit: (audit) => {
      auditSink = audit;
      service.useAudit(audit);
    },
    useHostnames: (names) => {
      extraNames = names;
    },

    register(app) {
      app.get('/api/v1/trust', async (req) => {
        await ctx.accountOf(req);
        return service.view();
      });

      app.patch('/api/v1/trust', async (req) => {
        const accountId = await ctx.accountOf(req);
        const body = trustPatchSchema.parse(req.body);
        await write(body, { actor: 'user', accountId });
        return service.view();
      });

      app.post('/api/v1/trust/renew', async (req) => {
        const accountId = await ctx.accountOf(req);
        const { target } = trustRenewSchema.parse(req.body ?? {});
        const mode = await ctx.setting(KEYS.mode);
        if (mode === 'none')
          throw new NovaError('conflict', 'no trust path is chosen', {
            details: { reason: 'trust_off' },
          });
        const who = { actor: 'user' as const, accountId };
        if (target === 'ca') {
          // Replacing the CA is the owner's explicit choice, never part of `all`.
          if (mode !== 'local-ca')
            throw new NovaError('conflict', 'the local CA is not the trust path', {
              details: { reason: 'no_local_ca' },
            });
          await service.rotateCa(who);
          return service.view();
        }
        const renewLeaf = (target === 'leaf' || target === 'all') && mode === 'local-ca';
        const mesh = service.meshCertificates();
        const renewMesh = target === 'mesh' || target === 'all' ? mesh : [];
        if (!renewLeaf && renewMesh.length === 0)
          throw new NovaError('conflict', 'nothing to renew in this trust mode', {
            details: { reason: target === 'leaf' ? 'no_local_ca' : 'no_mesh_cert' },
          });
        if (renewLeaf) await service.ensureLeaf({ force: true, who });
        for (const m of renewMesh) await service.requestMeshCert(m.host, who);
        return service.view();
      });

      // ---- public: the root certificate and the signed identity ----------------------------
      // Public information a device needs before it can trust the Hub: no credential, nothing
      // secret, and only while the local CA is the trust path.
      const root = async (): Promise<string> => {
        const pem = (await ctx.setting(KEYS.mode)) === 'local-ca' ? service.caCertificate() : null;
        if (!pem) throw new NovaError('not_found', 'the Hub has no local CA in use');
        return pem;
      };
      app.get('/api/v1/trust/ca.pem', async (_req, reply) => {
        const pem = await root();
        return reply
          .type('application/x-pem-file')
          .header('content-disposition', 'attachment; filename="nova-hub-ca.pem"')
          .send(pem);
      });
      // DER, the form phones open as a certificate to install.
      app.get('/api/v1/trust/ca.crt', async (_req, reply) => {
        const der = pemToDer(await root());
        return reply
          .type('application/x-x509-ca-cert')
          .header('content-disposition', 'attachment; filename="nova-hub-ca.crt"')
          .send(der);
      });
      // Signed by the Hub identity key: a forged or replayed answer cannot pass a pinned check.
      app.get('/api/v1/trust/identity', async (req, reply) => {
        const { nonce } = identityQuerySchema.parse(req.query);
        void reply.header('cache-control', 'no-store');
        return service.identityStatement(nonce);
      });
    },

    close() {
      clearInterval(interval);
      off();
      return chain.then(() => undefined);
    },
  };
  return area;
}
