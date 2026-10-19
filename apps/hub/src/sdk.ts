// Extensions (FR-117; docs/14 §4-§5, docs/26 §3; ADR-097 D1-D3) under /api/v1/extensions: install
// from an uploaded `.novax` or a bundle or folder on the Hub (preview first: signature, permissions
// in plain words, the permission diff of an update, hooks with their hashes), list, turn on and
// off, uninstall, the `nova dev` reload, commands and status items, and the secrets an extension
// declares (stored in the vault, never returned). Every route needs a session; they are Hub
// administration (owner-only, R-032). The service lives in @nova/core; this area wires it to the
// settings (`sdk.enabled`, `plugins.trustedPublishers`), the event bus (observable events reach
// the extensions that declared them) and the routes, and gives the other areas their seams: the
// tools (`ext:<id>/<name>`), the plugin permissions with extensions added, the hooks area's MCP
// client and gate for SDK hooks, and the panels for the MCP Apps area.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  devExtensionSchema,
  extensionSecretSchema,
  EXTENSION_SECRET_NAME,
  installExtensionSchema,
  isSettingKey,
  previewExtensionSchema,
  runExtensionCommandSchema,
  setExtensionEnabledSchema,
  type TrustedPublisher,
} from '@nova/shared';
import {
  ExtensionService,
  OBSERVABLE_EVENTS,
  managedRestrictions,
  type AuditSink,
  type ExtensionInstallPolicy,
  type ExtensionServiceOptions,
  type ExtensionUi,
  type HookMcpClient,
  type HookStore,
  type Notifier,
  type PluginPermissionSource,
  type PluginService,
  type ToolGate,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** Uploaded bundles are base64 in JSON: 32 MB of bundle is about 43 MB of body. */
export const EXTENSION_BODY_LIMIT = 48 * 1024 * 1024;

export interface SdkArea extends HubArea {
  service: ExtensionService;
  /** Running extensions' tools, `ext:<id>/<name>`, for the tools area's sources (D3). */
  tools: ToolSourceProvider;
  /** Plugin permissions with extensions' added: the gate and the tools area use this. */
  permissions(base: PluginPermissionSource): PluginPermissionSource;
  /** The hooks area's MCP client with SDK hooks added (`hooks.service.useMcp`). */
  hookClient(base: HookMcpClient | null): HookMcpClient;
  /** The hooks area's gate: a trusted SDK hook's run is allowed, the rest goes to `base`. */
  hookGate(base: ToolGate): ToolGate;
  /** Registered panels of running extensions, for the MCP Apps area (`apps.useExtensions`). */
  ui: { list(accountId: string): Promise<ExtensionUi[]> };
  useHookStore(store: HookStore | null): void;
  /** Managed policy's install check (U, D4). */
  useInstallPolicy(policy: ExtensionInstallPolicy | null): void;
  useNotifier(notifier: Notifier | null): void;
  useAudit(audit: AuditSink): void;
  /** Start the installed extensions (once the other areas are wired); resolves when tried. */
  start(): Promise<void>;
}

export interface SdkDeps {
  /** The plugins area's installer: an extension is a plugin. */
  plugins: PluginService;
  audit?: AuditSink;
  notifier?: Notifier;
  hookStore?: HookStore | null;
  policy?: ExtensionInstallPolicy | null;
  /** Keys Nova trusts itself (the built-in sample catalog's publisher). */
  builtinPublishers?: TrustedPublisher[];
  /** Tests: fetch, engine limits, timeouts. */
  host?: ExtensionServiceOptions['host'];
}

const params = z.object({ id: z.string().min(1).max(200) });
const commandParams = params.extend({ command: z.string().min(1).max(100) });
const statusParams = params.extend({ item: z.string().min(1).max(100) });
const secretParams = params.extend({ name: z.string().regex(EXTENSION_SECRET_NAME) });
const removeQuery = z.object({ removeData: z.enum(['true', 'false']).optional() });

export function setupSdk(ctx: HubContext, deps: SdkDeps): Promise<SdkArea> {
  const log = ctx.log.child('sdk');
  let audit: AuditSink | null = deps.audit ?? null;
  // A key not defined yet reads as its default: the SDK is on, nobody is trusted.
  const enabled = async () =>
    isSettingKey('sdk.enabled') ? await ctx.setting('sdk.enabled') : true;
  const trusted = async (): Promise<TrustedPublisher[]> =>
    isSettingKey('plugins.trustedPublishers') ? await ctx.setting('plugins.trustedPublishers') : [];
  // Managed policy (D4, FR-106): refused extensions do not install, start or run, and their
  // network stays within the egress restriction. An unreadable value fails closed.
  const managed = async () => managedRestrictions(await ctx.setting('managed.restrict'));
  const egress = async () => ({
    mode: await ctx.setting('network.egressMode'),
    deny: await ctx.setting('network.egressDeny'),
  });

  const service = new ExtensionService({
    db: ctx.db,
    secrets: ctx.secrets,
    dataDir: ctx.dataDir,
    plugins: deps.plugins,
    settings: { enabled, trustedPublishers: trusted, egress },
    managed,
    events: ctx.events,
    // Late-bound: the ops area's audit sink may arrive after setup.
    audit: { append: (r) => (audit ? audit.append(r) : Promise.resolve()) },
    log,
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    hookStore: deps.hookStore ?? null,
    policy: deps.policy ?? null,
    ...(deps.builtinPublishers ? { builtinPublishers: deps.builtinPublishers } : {}),
    ...(deps.host ? { host: deps.host } : {}),
    novaVersion: ctx.config.version,
  });

  // Observable events reach the extensions that declared them (docs/14 §4.1: observe only).
  const offEvents = OBSERVABLE_EVENTS.map((name) =>
    ctx.events.bus.subscribe(name, (e) => service.host.dispatchEvent(e)),
  );
  // The SDK switch: off stops every worker; on starts the installed, enabled extensions.
  const offSettings = ctx.events.bus.subscribe('settings.changed', (e) => {
    if (e.payload.key !== 'sdk.enabled') return;
    void (async () => {
      if (await enabled()) await service.startAll();
      else await service.stopAll();
    })().catch((err: unknown) => log.warn('the SDK switch could not be applied', { err }));
  });

  // A policy change (or a change of trusted publishers) stops what is now refused and starts
  // what is allowed again.
  const reapply = () =>
    void service
      .reapplyPolicy()
      .catch((err: unknown) => log.warn('managed policy not applied to extensions', { err }));
  const offPolicy = ctx.events.bus.subscribe('managed.policy.changed', reapply);
  const offTrust = ctx.events.bus.subscribe('settings.changed', (e) => {
    if (e.payload.key === 'plugins.trustedPublishers') reapply();
  });

  ctx.diagnostics.add('extensions', () => Promise.resolve(service.diagnostics()));

  function register(app: FastifyInstance): void {
    app.get('/api/v1/extensions', async (req) => ({
      items: await service.list(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/extensions/preview', { bodyLimit: EXTENSION_BODY_LIMIT }, async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = previewExtensionSchema.parse(req.body);
      return service.preview(accountId, body.source);
    });

    app.post('/api/v1/extensions', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = installExtensionSchema.parse(req.body);
      const view = await service.install(accountId, body);
      void reply.status(201);
      return view;
    });

    // `nova dev`: load or reload a local extension in one request (always unverified).
    app.post('/api/v1/extensions/dev', { bodyLimit: EXTENSION_BODY_LIMIT }, async (req) => {
      const accountId = await ctx.accountOf(req);
      const parsed = devExtensionSchema.safeParse(req.body);
      if (!parsed.success) {
        const sideload = parsed.error.issues.some((i) => i.path[0] === 'confirmSideload');
        throw new NovaError(
          'validation',
          sideload
            ? 'nova dev loads unverified code: confirm it with confirmSideload: true'
            : 'the body is not a nova dev request',
          sideload
            ? { details: { field: 'confirmSideload', reason: 'sideload_confirmation_required' } }
            : { details: { issues: parsed.error.issues.slice(0, 10) } },
        );
      }
      return service.dev(accountId, parsed.data);
    });

    app.get('/api/v1/extensions/contributions', async (req) =>
      service.contributions(await ctx.accountOf(req)),
    );

    app.get('/api/v1/extensions/:id', async (req) =>
      service.get(await ctx.accountOf(req), params.parse(req.params).id),
    );

    app.patch('/api/v1/extensions/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = setExtensionEnabledSchema.parse(req.body ?? {});
      return service.setEnabled(accountId, params.parse(req.params).id, body.enabled);
    });

    app.delete('/api/v1/extensions/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = removeQuery.parse(req.query);
      await service.uninstall(accountId, params.parse(req.params).id, {
        removeData: q.removeData === 'true',
      });
      return { ok: true };
    });

    app.post('/api/v1/extensions/:id/commands/:command/run', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = commandParams.parse(req.params);
      const body = runExtensionCommandSchema.parse(req.body ?? {});
      return service.runCommand(accountId, p.id, p.command, body.args ?? null);
    });

    app.post('/api/v1/extensions/:id/status/:item/click', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = statusParams.parse(req.params);
      return service.clickStatus(accountId, p.id, p.item);
    });

    // A declared secret's value goes to the vault; it is never returned.
    app.put('/api/v1/extensions/:id/secrets/:name', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = secretParams.parse(req.params);
      const body = extensionSecretSchema.parse(req.body);
      await service.setSecret(accountId, p.id, p.name, body.value);
      return { ok: true };
    });

    app.delete('/api/v1/extensions/:id/secrets/:name', async (req) => {
      const accountId = await ctx.accountOf(req);
      const p = secretParams.parse(req.params);
      await service.deleteSecret(accountId, p.id, p.name);
      return { ok: true };
    });
  }

  return Promise.resolve({
    service,
    tools: service.tools,
    permissions: (base) => service.permissionSource(base),
    hookClient: (base) => service.hookClient(base),
    hookGate: (base) => service.hookGate(base),
    ui: { list: (accountId) => Promise.resolve(service.uiPanels(accountId)) },
    useHookStore: (store) => service.useHookStore(store),
    useInstallPolicy: (policy) => service.useInstallPolicy(policy),
    useNotifier: (notifier) => service.useNotifier(notifier),
    useAudit(a: AuditSink) {
      audit = a;
    },
    start: () =>
      service.startAll().catch((err: unknown) => log.warn('extensions did not start', { err })),
    register,
    async close() {
      for (const off of offEvents) off();
      offSettings();
      offPolicy();
      offTrust();
      await service.close();
    },
  });
}
