// Hub HTTP/WS application (contracts/hub-api.md). `buildHub` wires routes onto a Fastify
// instance; `main.ts` owns process concerns (config, signals, ports).
import { existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  FIRMWARE_TOGGLE_KEYS,
  NovaError,
  SETTINGS,
  checkSettingWrite,
  isSettingKey,
  httpStatusFor,
  isNovaError,
  resolveAll,
  resolveSetting,
  uuidv7,
  type SettingKey,
  type SettingLayers,
} from '@nova/shared';
import {
  ChatService,
  MemoryService,
  NodeModelSource,
  NodeService,
  ProjectService,
  ProviderRegistry,
  Router,
  SourceService,
  SpendCaps,
  ThreadService,
  MockDesktops,
  browserDevServerGrant,
  browserDevServerOpener,
  detectLocalServers,
  isHubOwner,
  managedRestrictions,
  threadSandboxRouter,
  withSpendCaps,
  type ChatServiceOptions,
  type ModelRouter,
  type ProviderFactory,
  type SandboxEgress,
  type ThreadPolicySource,
  type ToolRuntimeOptions,
} from '@nova/core';
import { McpEventsClient, sdkClientTransport } from '@nova/mcp';
import { MemorySecretStore, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { AuthService, type Principal } from './auth.ts';
import { openStream, registerChatRoutes } from './chat-routes.ts';
import type { HubConfig } from './config.ts';
import { EventStore } from './event-store.ts';
import { registerMemoryRoutes } from './memory-routes.ts';
import { registerModelRoutes } from './model-routes.ts';
import { setupConsolidation } from './consolidation.ts';
import { mcpForHooks, setupHooks } from './hooks.ts';
import { pluginUiFromManifest, setupMcpApps } from './mcp-apps.ts';
import { setupMcpServer } from './mcp-server.ts';
import { setupPlugins } from './plugins.ts';
import { setupProfile } from './profile.ts';
import { setupWorkspace } from './workspace.ts';
import { setupAgents } from './agents.ts';
import { setupBrowser } from './browser.ts';
import { setupChannels } from './channels.ts';
import { setupCode } from './code.ts';
import { setupComputers } from './computers.ts';
import { setupDevices } from './devices.ts';
import { setupAddDevice } from './add-device.ts';
import { setupAgentDist } from './agent-dist.ts';
import { setupNetwork, type NetworkArea } from './network.ts';
import { setupNetworkSetup } from './network-setup.ts';
import { setupRelay, type RelayArea, type RelayDeps } from './relay.ts';
import { setupSync } from './sync.ts';
import { setupCloudRun } from './cloudrun.ts';
import { setupPush } from './push.ts';
import { setupTeam, type TeamArea, type TeamDeps } from './team.ts';
import { setupFlagged } from './flagged.ts';
import { setupDeviceTrust } from './device-trust.ts';
import { setupManaged, type ManagedArea, type ManagedDeps } from './managed.ts';
import { setupSdk } from './sdk.ts';
import { setupMarket } from './market.ts';
import { setupDatactl } from './datactl.ts';
import { setupAppAuth, type AppAuthArea } from './appauth.ts';
import { setupOtlp } from './otlp.ts';
import { setupFirmware } from './firmware.ts';
import { setupBoot } from './boot.ts';
import { setupOob } from './oob.ts';
import { setupTrust, type TrustArea } from './trust.ts';
import { setupScreen } from './screen.ts';
import { setupSpaces } from './spaces.ts';
import { setupRequests } from './requests.ts';
import { setupRuns } from './runs.ts';
import { setupSchedules } from './schedules.ts';
import { DiagnosticsRegistry, type HubArea, type HubContext } from './hub-context.ts';
import { deviceBridgeFrom, setupMcp } from './mcp.ts';
import { registerNodeRoutes } from './node-routes.ts';
import { setupOps } from './ops.ts';
import { setupPolicy } from './policy.ts';
import { setupTools, type ToolsArea } from './tools.ts';
import { registerProjectRoutes } from './project-routes.ts';

export const SESSION_COOKIE = 'nova_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface HubDeps {
  config: HubConfig;
  db: NovaDatabase;
  log: Logger;
  auth?: AuthService;
  events?: EventStore;
  /** Tests: a managed-policy settings layer in place of the managed area's (docs/12 §10, FR-106). */
  managedSettings?: (global?: Partial<Record<string, unknown>>) => Record<string, unknown>;
  /** Restart the Hub in place after a delete-all or an import (FR-105; `main.ts` passes it). */
  restart?: () => void;
  /** Tests: where the managed area reads its policy from (an environment, a file system, ...). */
  managed?: Omit<ManagedDeps, 'policy'>;
  /** Credential store (FR-101). Defaults to an in-memory store; `main.ts` passes the vault. */
  secrets?: SecretStore;
  /** Where blobs live (docs/06 §3); defaults to `config.dataDir`. */
  dataDir?: string;
  /** Override provider construction (tests use scripted mock providers). */
  providerFactory?: ProviderFactory;
  chat?: Pick<
    ChatServiceOptions,
    'flushIntervalMs' | 'deltaIntervalMs' | 'systemPrompt' | 'memoryTimeoutMs'
  >;
  /** How often temporary chats past their TTL are purged (default 10 min, FR-027). */
  sweepIntervalMs?: number;
  /** Relay connector timings and the pairing key-derivation cost (tests shorten them). */
  relay?: Pick<RelayDeps, 'backoff' | 'retransmitMs' | 'pingIntervalMs' | 'kdfIterations'>;
  /** Members' rate limits, the OIDC provider's fetch and a clock (tests). */
  team?: Pick<TeamDeps, 'fetch' | 'now' | 'limits' | 'purgeSweepMs'>;
  /** Replace the model router (tests); the default is the full Router (docs/07 §8-§9). */
  router?: (registry: ProviderRegistry) => ModelRouter;
  /** Probe for local model servers (tests replace it; docs/07 §12). */
  detect?: typeof detectLocalServers;
}

export interface Hub {
  app: FastifyInstance;
  auth: AuthService;
  events: EventStore;
  registry: ProviderRegistry;
  router: ModelRouter;
  nodes: NodeService;
  threads: ThreadService;
  chat: ChatService;
  projects: ProjectService;
  sources: SourceService;
  memory: MemoryService;
  /** Work runs (M5): `recover()` continues runs a restart interrupted (FR-052). */
  runs: { recover(): Promise<number> };
  /** M6.5 trust (FR-134): main.ts serves HTTPS with its certificates. */
  trust: TrustArea;
  /** M6.5 transports (FR-135): main.ts reports the listener so endpoints can be checked. */
  network: NetworkArea;
  /** M6.5 Relay connector (FR-137). */
  relay: RelayArea;
  /** M7 members, shared threads and team agents (FR-217, FR-091). */
  team: TeamArea;
  /** M8 third-party app authorization (FR-222). */
  appAuth: AppAuthArea;
  /** M8 managed policy (FR-106). */
  managed: ManagedArea;
  /** Every registered route, method and pattern (the route classification test, ADR-097 D7). */
  routes(): readonly { method: string; path: string }[];
}

/** The web app's policy; `connect` adds the Relay's origins when it is on (docs/22 §3). */
function contentSecurityPolicy(connect: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    ["connect-src 'self'", ...connect].join(' '),
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export async function buildHub(deps: HubDeps): Promise<Hub> {
  const { config, db, log } = deps;
  async function loadLayers(projectId?: string): Promise<SettingLayers> {
    const rows = await db.orm.select().from(schema.setting);
    const global: Record<string, unknown> = {};
    const project: Record<string, unknown> = {};
    for (const r of rows) {
      if (r.scopeKind === 'global') global[r.key] = JSON.parse(r.valueJson) as unknown;
      if (r.scopeKind === 'project' && r.scopeRef === projectId)
        project[r.key] = JSON.parse(r.valueJson) as unknown;
    }
    return {
      global,
      project,
      managed: deps.managedSettings?.(global) ?? managedLayer?.(global) ?? {},
    };
  }
  // The managed policy's settings layer (FR-106), set once the managed area is up.
  let managedLayer: ((global: Record<string, unknown>) => Record<string, unknown>) | null = null;
  const auth = deps.auth ?? new AuthService(db);
  const events = deps.events ?? new EventStore(db);
  const dataDir = deps.dataDir ?? config.dataDir;
  const secrets = deps.secrets ?? new MemorySecretStore();
  const registry = new ProviderRegistry({
    db,
    secrets,
    log: log.child('providers'),
    ...(deps.providerFactory ? { factory: deps.providerFactory } : {}),
  });
  const setting = async <K extends SettingKey>(key: K, projectId?: string | null) =>
    resolveSetting(key, await loadLayers(projectId ?? undefined)).value;
  // Compute nodes register with the Hub and serve models as a router source (FR-126, FR-127).
  const nodes = new NodeService({ db, secrets, events, log: log.child('nodes') });
  const fullRouter = new Router({
    registry,
    sources: [new NodeModelSource({ nodes })],
    settings: async () => {
      const layers = await loadLayers();
      return {
        presets: resolveSetting('models.presets', layers).value,
        order: resolveSetting('routing.order', layers).value,
        allowCloud: resolveSetting('routing.allowCloud', layers).value,
        providers: managedRestrictions(
          resolveSetting('managed.restrict', layers).value,
        ).providers(),
      };
    },
    log: log.child('router'),
  });
  // Spend caps stop a provider before its next model call (FR-116); fallbacks still run.
  const spend = new SpendCaps({ db, events, log: log.child('spend') });
  const router: ModelRouter = withSpendCaps(deps.router?.(registry) ?? fullRouter, spend);
  const threads = new ThreadService({
    db,
    router,
    events,
    defaultModel: () => setting('chat.defaultModel'),
  });
  const projects = new ProjectService({ db, events });
  const sources = new SourceService({ db, events, dataDir, log: log.child('sources') });
  const memory = new MemoryService({
    db,
    events,
    log: log.child('memory'),
    enabled: (projectId) => setting('memory.enabled', projectId),
  });
  const accountOf = async (req: FastifyRequest): Promise<string> => {
    const p = requireAuth(req);
    if (p.accountId) return p.accountId;
    // Only sessions authenticate here (auth.ts); one without an account acts for the owner.
    const owner = await auth.ownerAccount();
    if (!owner) throw new NovaError('auth_missing', 'the Hub has no owner account yet');
    return owner.id;
  };

  // ---- M3 areas: ops (audit, notifications, logs), policy and approvals, MCP, tools -------
  const ctx: HubContext = {
    config,
    db,
    log,
    events,
    secrets,
    dataDir,
    registry,
    router,
    nodes,
    threads,
    setting,
    accountOf,
    diagnostics: new DiagnosticsRegistry(),
  };
  // M8 managed policy (FR-106) comes first: every area reads its restrictions through settings.
  const managed = await setupManaged(ctx, { ...deps.managed });
  managedLayer = (global) => managed.settingsLayer(global);
  const ops = await setupOps(ctx);
  if (!deps.managed?.audit) managed.useAudit(ops.audit);
  const policy = await setupPolicy({ ...ctx, audit: ops.audit, notifier: ops.notifier });
  const mcp = await setupMcp({ ...ctx, audit: ops.audit });
  // M4: plugins (skills, their MCP servers and permissions) and hooks come before the tools,
  // whose chat loop uses them.
  const plugins = await setupPlugins({ ...ctx, audit: ops.audit, mcp });
  // The user's default approval per MCP server feeds the gate (FR-048). A plugin server's
  // manifest default is the plugin's: the gate reads it with the plugin's permissions.
  policy.useServerDefaults((_accountId, serverId) => Promise.resolve(mcp.serverDefault(serverId)));
  const hooks = await setupHooks({
    ...ctx,
    audit: ops.audit,
    gate: policy.gate,
    managedHooks: () => (deps.managedSettings?.() ?? managed.settingsLayer())['hooks'],
  });
  // Plugin hooks come from the plugins area, which shows how many wait for trust.
  hooks.usePluginHooks(plugins.hooks);
  plugins.useHookTrust((accountId, pluginId) => hooks.untrustedPluginHooks(accountId, pluginId));
  policy.useHooks(hooks.dispatcher);
  // M8 extensions (FR-117): an extension is a plugin whose handlers run in a sandboxed worker;
  // its declared permissions join the plugins' at the gate, its tools are `ext:<id>/<name>`.
  const sdk = await setupSdk(ctx, {
    plugins: plugins.service,
    audit: ops.audit,
    notifier: ops.notifier,
    hookStore: hooks.service.store,
  });
  sdk.useInstallPolicy({
    installProblem: async ({ extensionId, verified }) => {
      const restrict = managedRestrictions(await ctx.setting('managed.restrict'));
      return (
        restrict.extension(extensionId) ??
        (verified ? null : restrict.unverifiedInstall('an unverified extension'))
      );
    },
  });
  const pluginPermissions = sdk.permissions(plugins.permissions);
  policy.usePluginPermissions(pluginPermissions);
  hooks.useGate(sdk.hookGate(policy.gate));
  policy.usePluginViolations((accountId, pluginId) =>
    plugins.service.setEnabled(accountId, pluginId, false),
  );
  // M5: requests, schedules, Code sessions and runs come before the tools, whose sources include
  // their tools; what they need from the tools and the chat loop is bound late.
  let toolsRef: ToolsArea | null = null;
  const requests = await setupRequests(ctx, {
    notifier: ops.notifier,
    approvals: policy.approvals,
  });
  const schedules = await setupSchedules(ctx, { audit: ops.audit, notifier: ops.notifier });
  // The computers area (set up below) owns the egress proxy; container environments use it.
  let egressRef: SandboxEgress | null = null;
  const code = await setupCode({
    ...ctx,
    audit: ops.audit,
    sandbox: () => toolsRef?.sandbox ?? null,
    egress: () => egressRef,
  });
  const runs = await setupRuns({
    ...ctx,
    audit: ops.audit,
    notifier: ops.notifier,
    roots: async (accountId, threadId, projectId) =>
      toolsRef ? (await toolsRef.runtime.scopeFor(accountId, threadId, projectId)).roots : [],
  });
  // M6: computers (the tools' sandbox is theirs: network only through the egress proxy, an
  // agent's commands on its computer), then the areas whose tools the tools area lists.
  const computers = await setupComputers({ ...ctx, audit: ops.audit });
  egressRef = computers.egress;
  const channels = await setupChannels(ctx, {
    audit: ops.audit,
    // A Slack-compatible API elsewhere (a test double, a proxy); Slack's own API otherwise.
    ...(process.env.NOVA_SLACK_API_BASE ? { slackApiBase: process.env.NOVA_SLACK_API_BASE } : {}),
    // The Telegram Bot API elsewhere (a test double); Telegram's own API otherwise (M7).
    ...(process.env.NOVA_TELEGRAM_API_BASE
      ? { telegramApiBase: process.env.NOVA_TELEGRAM_API_BASE }
      : {}),
  });
  const agents = await setupAgents({ ...ctx, audit: ops.audit, notifier: ops.notifier });
  const browser = await setupBrowser(ctx, {
    gate: policy.gate,
    audit: ops.audit,
    notifier: ops.notifier,
  });
  const screen = await setupScreen({ ...ctx, audit: ops.audit });
  const devices = await setupDevices(ctx, { audit: ops.audit, notifier: ops.notifier });
  // M6.5: the Hub's identity and certificates (FR-134), its transports and endpoints (FR-135,
  // FR-139), Add Device (FR-132) and the signed novad builds it serves (FR-133).
  const trust = await setupTrust(ctx, { audit: ops.audit });
  const network = await setupNetwork(ctx, {
    audit: ops.audit,
    writeSetting: (accountId, key, value) =>
      writeSetting(accountId, { key, value, scope: 'global' }),
  });
  const addDevice = await setupAddDevice(ctx, {
    audit: ops.audit,
    notifier: ops.notifier,
    sessionCookie: SESSION_COOKIE,
  });
  const agentDist = setupAgentDist(ctx);
  // The identity until its key is loaded is none (hello answers null fields meanwhile).
  const hubIdentity = () => (trust.helloFields().hubFingerprint ? trust.identity : null);
  addDevice.useDevices(devices.service);
  addDevice.useHubIdentity(hubIdentity);
  addDevice.useCertIssuer({
    issueDeviceCertificate: (input) => trust.certIssuer.issueDeviceCertificate(input),
    revokeDeviceCertificates: (deviceId) => trust.revokeDevice(deviceId),
  });
  addDevice.useBootstrap((role, code, hubUrl, pairingId) =>
    agentDist.bootstrap(role, code, hubUrl, hubIdentity()?.fingerprint ?? null, pairingId),
  );
  addDevice.useEndpoints(() => Promise.resolve(network.endpoints()));
  agentDist.useHubIdentity(hubIdentity);
  devices.service.useWakeRouter(network.wakeRouter);
  network.useHubIdentity(hubIdentity);
  network.useTrustSummary(() => trust.trustSummary());
  network.useProbeCa(() => Promise.resolve(trust.service.caCertificate()));
  trust.useChangeLog(network.changes);
  trust.useHostnames(() => network.hostNames());
  // The Network Setup assistant (FR-136) verifies each change with the network area's checks
  // and registers its undo with the same change log; meshes feed endpoints and certificates.
  const listenerOf = () => network.registry.listener;
  const networkSetup = await setupNetworkSetup(ctx, {
    audit: ops.audit,
    hubPort: () => listenerOf()?.port ?? config.port,
    hubUrl: (host) =>
      `${listenerOf()?.protocol ?? 'http'}://${host}:${listenerOf()?.port ?? config.port}`,
  });
  networkSetup.useReachability({
    test: async () =>
      (await network.test()).transports.flatMap((t) =>
        t.endpoints.map((c) => ({
          transport: c.transport,
          url: c.url,
          ok: c.health === 'ok',
          latencyMs: c.latencyMs,
          detail: c.detail,
        })),
      ),
  });
  networkSetup.useChangeLog(network.changes);
  network.useEndpointSource(networkSetup.endpointSource);
  network.useMeshSummary(async () => ({ ...(await networkSetup.aclSummary()) }));
  trust.useMeshCerts(networkSetup.meshCerts);
  networkSetup.useTrust({
    ensureLocalCa: async () => ({ caFingerprint: (await trust.ensureLocalCa()).fingerprint }),
    requestMeshCert: (host) => trust.requestMeshCert(host),
  });
  // The Relay (FR-137): pairing goes through Add Device; tunneled requests are dispatched into
  // this Hub's own routes (`useInject` below) and authenticate like direct ones.
  const relay = await setupRelay(ctx, { audit: ops.audit, ...deps.relay });
  addDevice.useRelayPairing((input) => relay.openPairing(input));
  relay.usePairing(addDevice.service);
  relay.onClientRevoked((accountId, deviceId) => addDevice.revoker.revoke(accountId, deviceId));
  relay.useHubIdentity(hubIdentity);
  network.useEndpointSource(relay.endpointSource);
  network.useRelayStatus(() => Promise.resolve({ ...relay.status() }));
  // The Relay endpoint's health is the connector's state: a fresh check when it connects or drops,
  // so clients are told at once rather than at the next scheduled check (docs/22 §9.7).
  events.bus.subscribe('relay.status.changed', () => {
    network.registry
      .check()
      .catch((err: unknown) => log.warn('endpoint check after a Relay change failed', { err }));
  });
  networkSetup.useRelay({
    state: async () => {
      const st = relay.status();
      return {
        enabled: await ctx.setting('relay.enabled'),
        url: st.url,
        connected: st.state === 'connected',
      };
    },
    set: async ({ enabled, url }) => {
      // The URL first, so the connector never starts against the old one (the relay area applies
      // settings as they change).
      await writeSetting(null, { key: 'relay.url', value: url ?? '', scope: 'global' });
      await writeSetting(null, { key: 'relay.enabled', value: enabled, scope: 'global' });
    },
  });
  // M7 push (FR-111): Web Push from the Hub, native apps through the Relay; the notification
  // routing's OS leg sends redacted payloads (docs/13 §6).
  const push = await setupPush(ctx, { audit: ops.audit });
  push.useRelay(relay.hub);
  channels.usePush(push.leg);
  channels.useNotifier(ops.notifier);
  // M7 device trust (FR-126): device and node routes check the certificate a device presents.
  const deviceTrust = await setupDeviceTrust(ctx, {
    verifyDeviceCertificate: (pem) => trust.verifyDeviceCertificate(pem),
    // A renewed certificate the device presents retires its old one (ADR-096).
    certificatePresented: (deviceId, serial) =>
      trust.service.deviceCertificatePresented(deviceId, serial),
    audit: ops.audit,
  });
  // M7.5 (ADR-096): the management channel over mutual TLS (D1), Hub-signed authorizations for
  // privileged device actions (D2), device certificate renewal, firmware (FR-146), boot profiles
  // and PXE (FR-143) and out-of-band management (FR-147), all owner-only and off by default.
  devices.useManagementTls({
    material: () => trust.service.hubClientCertificate(),
    verifyDeviceCertificate: (pem) => trust.verifyDeviceCertificate(pem),
    allowLegacyServerCertificate: (deviceId, pem) =>
      trust.service.legacyServerCertificateAllowed(deviceId, pem),
    presented: (deviceId, serial) => trust.service.deviceCertificatePresented(deviceId, serial),
    certificateState: (deviceId) => trust.service.deviceCertificateState(deviceId),
  });
  devices.useCertificateRenewal((deviceId, key) =>
    trust.service.deviceCertificateRenewal(deviceId, key),
  );
  devices.useAuthzSigner(trust.identity);
  devices.useAvailableBuilds(async () => (await agentDist.manifest()).manifest);
  nodes.useAudit(ops.audit);
  const firmware = await setupFirmware(ctx, {
    devices: devices.service,
    audit: ops.audit,
    notifier: ops.notifier,
    identity: hubIdentity,
    // The settings writer's `settings.changed` (before, after, confirmed) is the toggle's one
    // audit entry, written by the ops subscriber (ADR-096 D3).
    writeSetting: (accountId, key, value, opts) =>
      writeSetting(accountId, { key, value, scope: 'global' }, opts),
  });
  firmware.useDeviceCall((d, path, body, ms) =>
    devices.service.call(d.row.accountId, d.row.id, path, body, ms),
  );
  const oob = await setupOob(ctx, {
    audit: ops.audit,
    notifier: ops.notifier,
    writeSetting: (accountId, key, value, opts) =>
      writeSetting(accountId, { key, value, scope: 'global' }, opts),
  });
  const boot = await setupBoot(ctx, {
    devices: devices.service,
    audit: ops.audit,
    notifier: ops.notifier,
  });
  boot.useHubIdentity(hubIdentity);
  boot.usePowerCycle((accountId, deviceId) => oob.powerCycleFor(accountId, deviceId));
  devices.useFirmwarePolicy((device) => firmware.heartbeatPolicy(device));
  devices.useBootPolicy(() => boot.lowLevelBoot());
  devices.service.onHeartbeatEvents((accountId, deviceId, events) =>
    firmware.heartbeatEvents(accountId, deviceId, events),
  );
  devices.service.onHeartbeatEvents((accountId, deviceId, events) =>
    boot.heartbeatEvents(accountId, deviceId, events),
  );
  // M7 cloud runner (FR-108, FR-071): a cloud environment's commands and files run on the runner.
  const cloudrun = await setupCloudRun(ctx, { audit: ops.audit, notifier: ops.notifier });
  code.service.envs.useCloud(cloudrun.provider);
  code.service.useEnvironmentTransport('cloud', cloudrun.transportFor);
  cloudrun.useRuns(runs.service);
  // M7 flagged features (FR-202, FR-203): off by default; their tools join the tools area.
  const flagged = await setupFlagged(ctx, { audit: ops.audit });
  const spaces = await setupSpaces(ctx, { audit: ops.audit });
  // A Code session on another machine runs its commands there (FR-062); every other command
  // goes through the computers area's router.
  const sandbox = threadSandboxRouter(
    computers.router(computers.sandbox),
    (accountId, threadId) =>
      code.sandboxForThread(accountId, threadId) ?? cloudrun.sandboxForThread(accountId, threadId),
  );
  // The apps area exists after the tools; the chat loop reads its model context late-bound.
  let mcpApps: Awaited<ReturnType<typeof setupMcpApps>> | null = null;
  const tools = await setupTools({
    ...ctx,
    gate: policy.gate,
    sandbox,
    // Image generation checks spend caps and records its usage (FR-116, M8 data review #9).
    spend,
    sources: [
      mcp.source,
      plugins.skills.tools,
      runs.tools,
      code.tools,
      code.toolsM6,
      requests.tools,
      schedules.reportTools,
      agents.tools,
      channels.tools,
      spaces.tools,
      // An agent's tools for the files of its connected computer (FR-081, FR-210).
      devices.tools,
      browser.tools,
      flagged.tools,
      sdk.tools,
      // Computer use goes last (its tools defer to the browser's and the shell's).
      screen.tools,
    ],
    audit: ops.audit,
    notifier: ops.notifier,
    hooks: hooks.dispatcher,
    skills: plugins.skills,
    pluginPermissions,
    appContext: (accountId, threadId) =>
      Promise.resolve(mcpApps ? mcpApps.modelContext(accountId, threadId) : null),
  });
  toolsRef = tools;
  // A Code session's permission mode, a run's autonomy and an agent's autonomy set the gate's
  // approval policy and the tools' profile and roots for their threads (FR-063, docs/09 §10);
  // both read the same sources. An agent's threads work in its computer's folder (FR-080).
  const agentThreads: ThreadPolicySource = {
    forThread: async (accountId, threadId) => {
      const p = await agents.policy.forThread(accountId, threadId);
      if (!p) return null;
      const c = await computers.threadPolicy.forThread(accountId, threadId);
      return c?.roots ? { ...p, roots: c.roots } : p;
    },
  };
  // M7 members and team agents (FR-217, FR-091): each source is scoped to the thread's people,
  // and the team's own fallback goes last. A cloud Work run's policy wraps the runs' one.
  const team = await setupTeam(ctx, {
    auth,
    audit: ops.audit,
    sessionCookie: SESSION_COOKIE,
    approvals: policy.approvals,
    ...deps.team,
  });
  // A removed member's live connections end at once (decision 5): their open sockets and event
  // streams close, and their MCP servers disconnect.
  const liveByAccount = new Map<string, Set<() => void>>();
  const holdLive = (accountId: string, end: () => void) => {
    const set = liveByAccount.get(accountId) ?? new Set<() => void>();
    set.add(end);
    liveByAccount.set(accountId, set);
    return () => {
      set.delete(end);
      if (!set.size) liveByAccount.delete(accountId);
    };
  };
  team.onMemberRemoved(async (accountId) => {
    for (const end of [...(liveByAccount.get(accountId) ?? [])]) end();
    for (const st of mcp.manager.states(accountId)) await mcp.manager.remove(st.id);
  });
  // A Code session on another machine gives the tool runtime no root on the Hub's disk (mentions,
  // instruction files, hooks and the file browser), while the gate keeps the remote folder as its
  // root: its file tools reach that folder through the session's helper (ADR-095).
  for (const source of [code.policy, cloudrun.workPolicy(runs.policy), agentThreads]) {
    policy.useThreadPolicy(team.scoped(source));
    tools.useThreadPolicy(team.scoped(source === code.policy ? code.toolPolicy : source));
  }
  const fallback = team.scoped();
  policy.useThreadPolicy(fallback);
  tools.useThreadPolicy(fallback);
  policy.gate.useToolLimits(team.toolLimits);
  policy.gate.useToolLimits(runs.service.toolLimits);
  policy.gate.useToolLimits(agents.service.toolLimits);
  // An agent's plugin limits follow it into the Code sessions it delegated (M7).
  policy.gate.useToolLimits(code.delegatedToolLimits(agents.service.toolLimits));
  // An agent's skill catalog shows only the skills of plugins connected to it (M8).
  plugins.index.useLimits(agents.service.toolLimits);
  plugins.index.useLimits(code.delegatedToolLimits(agents.service.toolLimits));
  requests.status.useLinks(agents.service.statusLinks);
  team.useAgents(agents.service);
  flagged.useRuntime(tools.runtime);
  flagged.useGate(policy.gate);
  // An external agent runs in the session's own sandbox (refused where it has none, M7).
  flagged.useSandbox(
    () => sandbox,
    (accountId, threadId) => code.sandboxForThread(accountId, threadId),
  );
  // MCP servers hosted on a device run there, through novad (FR-042).
  mcp.useDeviceBridge(deviceBridgeFrom(devices.service));
  // An agent's rules join the policy set of its threads (FR-084).
  // A Code session an agent delegated keeps the agent's rules (M7).
  // The cloud runner adds its rules (no Hub file tools in cloud threads, M7).
  policy.useAgentPolicy(cloudrun.toolRules(code.delegatedRules(agents.agentPolicy)));
  code.useAgents({
    agentOf: async (accountId, threadId) => {
      const l = await agents.service.agentOfThread(accountId, threadId);
      return l ? { agentId: l.agentId, kind: l.kind, audience: l.audience } : null;
    },
    mainThread: (accountId, agentId) => agents.service.mainThreadOf(accountId, agentId),
    budgets: async (accountId, agentId) => (await agents.service.get(accountId, agentId)).budgets,
    isActive: (accountId, agentId) => agents.service.isActive(accountId, agentId),
  });
  requests.useStatusSources(runs.status, code.status, agents.status);
  agents.useStatus((accountId, ids) => requests.status.statusOf(accountId, ids));
  runs.useStatus((accountId, ids) => requests.status.statusOf(accountId, ids));
  runs.useReviewReset((key) => policy.gate.resetReviewBreaker(key));
  schedules.useRuns(runs.starter);
  runs.useDelivery(async ({ accountId, runId, summary }) => {
    const r = await schedules.verifyMessageOutput(accountId, runId, summary);
    return r.verified ? { ok: true, evidence: r.evidence } : { ok: false, reason: r.evidence };
  });
  ops.useDiagnosticTests({ mcp: mcp.manager, sandbox: () => tools.sandbox });
  // The gate previews and classifies with the tools' own descriptors and the sandbox in use.
  policy.useToolCatalog(tools.catalog);
  // A thread's own sandbox decides its isolation (a cloud thread's is the runner's, M7).
  policy.useSubstrate((accountId, threadId) => sandbox.substrateFor(accountId, threadId));
  hooks.useSandbox(tools.sandbox);
  // Hooks reach MCP servers and, for an extension's own hooks, its worker (FR-117).
  hooks.service.useMcp(sdk.hookClient(mcpForHooks(mcp.manager)));
  const scope: ToolRuntimeOptions['scope'] = (input) =>
    tools.runtime.scopeFor(input.accountId, input.threadId, input.projectId);
  hooks.useScope(scope);
  const consolidation = await setupConsolidation({ ...ctx, memory });
  const mcpServer = await setupMcpServer({
    ...ctx,
    audit: ops.audit,
    gate: policy.gate,
    tools,
    skills: {
      list: (accountId) => plugins.index.list(accountId, null),
      resolve: (accountId, name) => plugins.skills.resolve(accountId, null, name),
    },
  });
  const apps = await setupMcpApps({ ...ctx, mcp });
  mcpApps = apps;
  apps.useExtensions(sdk.ui);
  apps.usePlugins({
    list: async (accountId) =>
      (await plugins.enabledManifests(accountId)).flatMap((p) => {
        const ui = pluginUiFromManifest(p.manifest);
        return ui ? [ui] : [];
      }),
  });
  const workspace = await setupWorkspace({
    ...ctx,
    audit: ops.audit,
    gate: policy.gate,
    sandbox: () => tools.sandbox,
    scope,
  });
  code.useTerminals(workspace.terminals);
  const profile = await setupProfile({
    ...ctx,
    audit: ops.audit,
    mcp,
    plugins,
    folders: workspace.folders,
    memory,
    projects,
  });
  // ---- M6 wiring (docs/09 §7-§8, docs/11, docs/13 §4, docs/23) ---------------------------------
  // Cloud computers' desktops (mock until a cloud provider serves real ones, FR-093).
  const desktops = new MockDesktops();
  // Agents: schedules and wakes, delegated runs, their computer, quiet hours, deletion.
  agents.useScheduler(schedules.service);
  schedules.service.useAgents(agents.scheduleTarget);
  agents.useRuns({
    createRun: (input) => runs.starter.createRun(input),
    whenFinished: (accountId, runId) => runs.starter.whenFinished(accountId, runId),
    pause: (accountId, runId) => runs.service.pause(accountId, runId),
    resume: (accountId, runId) => runs.service.resume(accountId, runId),
    cancel: (accountId, runId) => runs.service.cancel(accountId, runId),
  });
  agents.useComputers(computers.service);
  agents.useQuietHours((accountId, at) => channels.quietHours(accountId, at));
  agents.onDelete((accountId, agentId) => channels.removeForAgent(accountId, agentId));
  // Deleting an agent removes its computer with its browser session, screen records and desktop.
  agents.onDelete(async (accountId, agentId) => {
    for (const c of await computers.service.list(accountId)) {
      if (c.agentId !== agentId) continue;
      await browser.service.closeSession(accountId, c.id);
      await screen.service.purgeComputer(accountId, c.id);
      desktops.delete(c.id);
    }
    await computers.service.purgeAgent(accountId, agentId);
  });
  // Channels: turns, runs, approvals answered from a channel, the owner's share questions, the
  // agents' threads and the external-agent rule (FR-088, FR-100, FR-194), MCP events (FR-201).
  channels.useApprovals(policy.approvals);
  channels.useRequests(requests.service);
  channels.useRuns(runs.starter);
  channels.useAgents({
    threadFor: agents.channels.threadFor,
    agentThread: agents.channels.agentThread,
    externalAgents: agents.externalAgentGuard,
  });
  channels.useMcp(new McpEventsClient(sdkClientTransport((id) => mcp.manager.sdkClient(id))));
  mcp.onServerRemoving((accountId, serverId) =>
    channels.mcpEvents.removeForServer(accountId, serverId),
  );
  schedules.useChannel('slack', channels.delivery.slack);
  schedules.useChannel('teams', channels.delivery.teams);
  schedules.useChannel('email', channels.delivery.email);
  ops.useNotificationRouting(channels.routing);
  // Computers: the browser and the desktop of each computer, and devices as local hosts.
  computers.useBrowser(browser.service.browserFactory());
  computers.useScreen((computer) =>
    Promise.resolve(computer.kind === 'cloud' ? desktops.screen(computer.id) : null),
  );
  computers.useLocalHost(devices.computers);
  devices.useComputers(computers.service);
  devices.useAgents(async (accountId, agentId) => {
    try {
      await agents.service.get(accountId, agentId);
      return true;
    } catch {
      return false;
    }
  });
  devices.useAgentThreads((accountId, threadId) =>
    agents.service.agentOfThread(accountId, threadId),
  );
  code.useDevices(devices.codeEnvironments);
  // The browser: its artifacts, egress, computers, the thread's computer and the external-agent
  // rule (FR-092..FR-098, FR-194).
  browser.useArtifacts(tools.artifacts);
  browser.useEgress(computers.proxy);
  browser.useComputers(computers.service);
  browser.useComputerResolver(async (accountId, threadId) => {
    if (!threadId) return null;
    const agentId = await computers.service.agentOfThread(accountId, threadId);
    return agentId ? (await computers.service.forAgent(accountId, agentId)).id : null;
  });
  browser.useExternalAgentGuard(agents.externalAgentGuard);
  // Dev servers of Code sessions (FR-097, FR-067): the session thread's browser may reach the
  // dev server's bridge port on 127.0.0.1, and the browser pane opens it once it answers.
  code.useDevServerGrant(browserDevServerGrant(browser.service));
  code.useBrowserOpener(browserDevServerOpener(browser.service));
  // Computer use (FR-093, FR-207) and takeover (FR-087): the kill key and a takeover pause the
  // agent that uses the computer and its browser; returning control resumes what they paused.
  screen.useComputers(computers.service);
  screen.useComputerOf(async (accountId, threadId) => {
    const agentId = await computers.service.agentOfThread(accountId, threadId);
    if (!agentId) return null;
    return { computerId: (await computers.service.forAgent(accountId, agentId)).id, agentId };
  });
  screen.useRequests(requests.service);
  const pausedByScreen = new Set<string>();
  const agentOfComputer = async (accountId: string, computerId: string) =>
    (await computers.service.view(accountId, computerId).catch(() => null))?.agentId ?? null;
  screen.useAgentControl({
    pause: async ({ accountId, computerId, reason }) => {
      await browser.service.pauseComputer(accountId, computerId, reason).catch(() => undefined);
      const agentId = await agentOfComputer(accountId, computerId);
      if (!agentId) return;
      const agent = await agents.service.get(accountId, agentId);
      if (agent.status !== 'active') return;
      await agents.service.pause(accountId, agentId, {
        reason: 'user',
        detail: reason === 'kill' ? 'stopped with the kill key' : 'you took over its computer',
      });
      pausedByScreen.add(agentId);
    },
    resume: async ({ accountId, computerId }) => {
      await browser.service.resumeComputer(accountId, computerId).catch(() => undefined);
      const agentId = await agentOfComputer(accountId, computerId);
      if (!agentId || !pausedByScreen.delete(agentId)) return;
      // The user may have resumed it already: nothing to undo then.
      const agent = await agents.service.get(accountId, agentId);
      if (agent.status === 'paused') await agents.service.resume(accountId, agentId);
    },
  });
  // Local browser fallback (FR-209) on a connected computer's browser through novad, and the
  // extension bridge (FR-096): the offer asks the user, and the device's browser is reached over
  // the management channel (M7.5).
  browser.useRequests(requests.service);
  browser.useDevices(devices.service, agentOfComputer);
  spaces.useAudit(ops.audit);
  // M7 sync (FR-109, FR-129): the Hub's change feed for device replicas, and idempotent writes.
  const sync = await setupSync(ctx, {
    audit: ops.audit,
    services: {
      projects,
      memory,
      spaces: spaces.spaces,
      schedules: schedules.service,
      setting: (accountId, key, value) => writeSetting(accountId, { key, value, scope: 'global' }),
    },
  });
  // M8: the marketplace (FR-049), data controls and spend caps (FR-105, FR-116, FR-121), third-
  // party app authorization (FR-222) and OTLP export (FR-223); managed policy is set up first.
  const market = await setupMarket(ctx, {
    plugins: { service: plugins.service, index: plugins.index },
    audit: ops.audit,
    writeSetting: (accountId, key, value) =>
      writeSetting(accountId, { key, value, scope: 'global' }),
  });
  market.useMcpInstaller(mcp.marketInstaller);
  // Extensions from the marketplace install through the SDK, which checks their signature (FR-117).
  market.useExtensionInstaller(sdk.service);
  // Delete-all and import replace every row, then the Hub restarts: background writers stop first
  // (`quiesce`, bound below once the chat loop exists; M8 data review #13). Without a restart to
  // follow, nothing is stopped.
  let quiesceHub: (() => Promise<void>) | null = null;
  const datactl = await setupDatactl(ctx, {
    audit: ops.audit,
    notifier: ops.notifier,
    spend,
    ...(deps.restart
      ? { restart: deps.restart, quiesce: () => quiesceHub?.() ?? Promise.resolve() }
      : {}),
  });
  // A removed member's data, offered to the owner as an account-scoped export before the purge.
  team.useExporter(datactl.memberExporter);
  const appAuth = await setupAppAuth(ctx, { auth, audit: ops.audit });
  const otlp = await setupOtlp(ctx, {
    audit: ops.audit,
    version: config.version,
    writeSetting: (accountId, key, value) =>
      writeSetting(accountId, { key, value, scope: 'global' }),
  });
  const areas = [
    managed,
    sdk,
    market,
    datactl,
    appAuth,
    otlp,
    firmware,
    boot,
    oob,
    sync,
    cloudrun,
    push,
    team,
    flagged,
    deviceTrust,
    trust,
    network,
    networkSetup,
    relay,
    addDevice,
    agentDist,
    spaces,
    devices,
    agents,
    channels,
    screen,
    browser,
    computers,
    code,
    schedules,
    runs,
    requests,
    profile,
    workspace,
    apps,
    mcpServer,
    tools,
    hooks,
    plugins,
    consolidation,
    mcp,
    policy,
    ops,
  ];

  const chat = new ChatService({
    db,
    router,
    threads,
    events,
    dataDir,
    log: log.child('chat'),
    memory,
    sources,
    settings: {
      followUp: (projectId) => setting('general.followUp', projectId),
      temporaryTtlHours: () => setting('chat.temporaryTtlHours'),
    },
    ...tools.chatOptions,
    ...tools.loopOptions,
    // Runs, Code sessions and agents shape each turn on their threads (docs/09 §2, §8, §11).
    extensions: [runs.extension, code.extension, agents.extension, cloudrun.extension],
    ...deps.chat,
  });
  // Runs, Code sessions, agents, channels and schedules start turns through the same loop
  // (ADR-076).
  runs.useTurns(chat.turnStarter);
  code.useTurns(chat.turnStarter);
  agents.useTurns(chat.turnStarter);
  channels.useTurns(chat.turnStarter);
  chat.useAccess(team.access);
  team.useChat(chat);
  // Offline user messages can ask for their reply once the device is back (FR-112, M7).
  sync.useChat(chat);
  // Time spent waiting for the user's answer does not count against a run's time budget.
  events.bus.subscribe('request.*', (e) => {
    const threadId = e.correlation?.threadId;
    if (!threadId) return;
    if (e.name === 'request.created') chat.awaitingUser(threadId, true);
    else if (e.name === 'request.resolved' || e.name === 'request.expired')
      chat.awaitingUser(threadId, false);
  });
  // A run's interactive exec sessions end with it (FR-184).
  events.bus.subscribe('run.completed', (e) => {
    const threadId = e.correlation?.threadId;
    if (threadId && e.accountId)
      void tools.execSessions.killThread(e.accountId, threadId, 'killed').catch(() => undefined);
  });
  // The public address inbound webhooks use (`channels.publicUrl`, docs/13 §4) is a name the Hub
  // answers to, like the configured origins; it follows the setting.
  const publicHosts = new Set<string>();
  // The Hub's own advertised names (its mDNS name, the direct public address) are too (FR-135):
  // an endpoint the Host check refused would fail its own reachability test.
  const refreshPublicHosts = async () => {
    const url = await setting('channels.publicUrl');
    const names = await network.hostNames();
    publicHosts.clear();
    for (const n of names) publicHosts.add(n.toLowerCase());
    if (!url) return;
    try {
      const u = new URL(url);
      publicHosts.add(u.host.toLowerCase());
      publicHosts.add(u.hostname.toLowerCase());
    } catch {
      // not a URL: nothing to add
    }
  };
  const refreshHosts = () =>
    refreshPublicHosts().catch((err: unknown) => log.warn('public names not read', { err }));
  await refreshPublicHosts();
  events.bus.subscribe('settings.changed', (e) => {
    const key = typeof e.payload.key === 'string' ? e.payload.key : '';
    if (key === 'channels.publicUrl' || key.startsWith('network.')) void refreshHosts();
  });
  network.useHostNamesChanged(refreshPublicHosts);
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    genReqId: () => uuidv7(),
    trustProxy: false,
  });
  // Every route as registered (method and pattern), for the route classification (ADR-097 D7):
  // Fastify's printed route tree folds some wildcard paths, so it cannot be read back exactly.
  const registered: { method: string; path: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat())
      if (method !== 'HEAD') registered.push({ method, path: route.url });
  });
  // Requests the Relay tunnels in arrive from `relay:<client id>`: dispatched in-process, so the
  // network setup's lock-out guard learns their transport here (FR-136).
  relay.useInject(app);
  networkSetup.useRequestTransport((req) => (req.ip.startsWith('relay:') ? 'relay' : null));

  // Open event streams are ended before the server closes, and running turns are cancelled and
  // saved before the database goes away (FR-018).
  const streams = new Set<() => void>();
  const trackStream = (end: () => void) => {
    streams.add(end);
    return () => streams.delete(end);
  };
  app.addHook('preClose', (done) => {
    for (const end of [...streams]) end();
    done();
  });
  // Temporary chats past their TTL are purged in the background (FR-027); main.ts also sweeps
  // at startup.
  const sweeper = setInterval(
    () => {
      chat.sweepTemporary().catch((err: unknown) => log.warn('temporary sweep failed', { err }));
    },
    deps.sweepIntervalMs ?? 10 * 60_000,
  );
  sweeper.unref();
  nodes.start();
  // Quiesce (delete-all, import): no new turns (running ones end and are saved), schedulers,
  // pollers, sweeps and compute-node checks stop, every area closes but the data controls (which
  // answer) and ops (the audit sink), and pending writes, the audit among them, are flushed. The
  // close that the restart runs skips what this closed.
  const quiesced = new Set<HubArea>();
  let stopped = false;
  const stopLoops = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweeper);
    nodes.stop();
    await chat.shutdown();
    await sources.stop();
  };
  quiesceHub = async () => {
    await stopLoops();
    for (const a of areas) {
      if (a === datactl || a === ops || quiesced.has(a)) continue;
      quiesced.add(a);
      await a.close();
    }
    await db.transaction(() => undefined);
  };
  app.addHook('onClose', async () => {
    await stopLoops();
    for (const a of areas) if (!quiesced.has(a)) await a.close();
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), usb=()');
    reply.header('Content-Security-Policy', contentSecurityPolicy(relay.connectOrigins()));
    guardHostAndOrigin(req, config, publicHosts);
    req.principal = await authenticate(req, auth);
  });
  // A request queued offline and sent again carries the same Idempotency-Key: its first answer is
  // replayed and its effect never repeated (FR-112, ADR-095).
  app.addHook('preHandler', sync.idempotency.preHandler);
  app.addHook('onSend', sync.idempotency.onSend);
  app.addHook('onResponse', sync.idempotency.onResponse);

  app.addHook('onResponse', (req, reply, done) => {
    log.info('request', {
      method: req.method,
      // The route pattern, never the path: some routes carry a token in the path (PXE boot
      // tokens, one-use approval links), and logs may leave the machine through OTLP (FR-223).
      url: req.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      requestId: req.id,
    });
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err)) {
      void reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
      return;
    }
    if (err instanceof z.ZodError) {
      const body = new NovaError('validation', 'request failed validation', {
        details: {
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      void reply.status(400).send({ error: body.toJSON(), requestId: req.id });
      return;
    }
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) log.error('unhandled error', { err, requestId: req.id });
    const code = status === 404 ? 'not_found' : status < 500 ? 'validation' : 'server_error';
    const message = status < 500 && err instanceof Error ? err.message : 'internal error';
    void reply
      .status(status)
      .send({ error: { code, message, retryable: status >= 500 }, requestId: req.id });
  });

  // ---- public ---------------------------------------------------------------------------
  app.get('/api/v1/hello', async () => ({
    name: 'nova-hub',
    version: config.version,
    apiVersions: ['v1'],
    features: [],
    setupRequired: (await auth.ownerAccount()) === null,
    ...trust.helloFields(),
  }));

  // The authenticated handshake (contracts/hub-api.md §1, §5): the server-request kinds this
  // client takes and the `clientSessionId` its socket names (FR-188).
  const helloBody = z
    .object({
      capabilities: z.object({ serverRequests: z.unknown() }).partial().optional(),
    })
    .passthrough();
  app.post('/api/v1/hello', async (req) => {
    const accountId = await accountOf(req);
    const body = helloBody.parse(req.body ?? {});
    return {
      name: 'nova-hub',
      version: config.version,
      apiVersions: ['v1'],
      // The endpoints that passed their own reachability test (FR-135, docs/22 §9.7).
      endpoints: network.endpoints(),
      ...requests.hello({
        accountId,
        deviceId: req.principal?.tokenId ?? null,
        serverRequests: body.capabilities?.serverRequests,
      }),
    };
  });

  app.get('/api/v1/health', () => ({ status: 'ok', version: config.version }));

  // ---- auth -----------------------------------------------------------------------------
  const setupBody = z.object({
    code: z.string().min(10).max(200),
    displayName: z.string().max(100).optional(),
  });
  app.post('/api/v1/auth/setup', async (req, reply) => {
    const body = setupBody.parse(req.body);
    const { session, accountId } = await auth.redeemSetupCode(body.code, body.displayName);
    // Local-first: a fresh owner can chat offline at once with the mock provider.
    await registry.ensureDefaultProvider(accountId);
    void reply.setCookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    await events.emit({
      name: 'auth.session.created',
      actor: 'user',
      accountId,
      payload: { accountId },
    });
    return { accountId };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const p = requireAuth(req);
    await auth.revoke(p.tokenId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await events.emit({
      name: 'auth.session.revoked',
      actor: 'user',
      accountId: p.accountId ?? undefined,
      payload: { accountId: p.accountId },
    });
    return { ok: true };
  });

  app.get('/api/v1/session', async (req) => {
    const p = requireAuth(req);
    const account = p.accountId ? await auth.account(p.accountId) : null;
    return {
      accountId: p.accountId,
      displayName: account?.displayName ?? null,
      kind: p.kind,
      // A device session (Add Device) names its device and scopes; the owner's own browser not.
      deviceId: p.deviceId ?? null,
      scopes: p.scopes ?? null,
      role: p.accountId ? team.roleOf(p.accountId) : null,
    };
  });

  // ---- settings (docs/14 §1) --------------------------------------------------------------

  app.get('/api/v1/settings', async (req) => {
    requireAuth(req);
    const q = z.object({ projectId: z.string().optional() }).parse(req.query);
    return { settings: resolveAll(await loadLayers(q.projectId)) };
  });

  const patchBody = z.object({
    key: z.string().min(1).max(200),
    value: z.unknown(),
    scope: z.enum(['global', 'project']).default('global'),
    projectId: z.string().optional(),
    /** The owner confirmed what a consent switch allows (ADR-096 D3). */
    confirm: z.literal(true).optional(),
  });
  // Switches that widen what the Hub may do to devices turn on only with an explicit
  // confirmation, here as on their own routes (ADR-096 D3; the M7.5 review): the Settings dialog
  // sends `confirm: true` after the owner reads what the switch allows. Out-of-band management has
  // its own consent route and its area refuses it here.
  const CONSENT_KEYS = new Set<string>([
    ...FIRMWARE_TOGGLE_KEYS,
    'devices.boot.allowLowLevel',
    'devices.pxe.enabled',
  ]);
  app.patch('/api/v1/settings', async (req) => {
    const p = requireAuth(req);
    const body = patchBody.parse(req.body);
    if (CONSENT_KEYS.has(body.key) && body.value === true && body.confirm !== true)
      throw new NovaError('policy_denied', 'turning this on needs an explicit confirmation', {
        details: { reason: 'consent_required' },
      });
    await writeSetting(p.accountId, body, { confirmed: body.confirm === true });
    return { settings: resolveAll(await loadLayers(body.projectId)) };
  });

  /** Validate and store one setting, then announce it (docs/14 §1). */
  async function writeSetting(
    accountId: string | null,
    body: z.infer<typeof patchBody>,
    opts: { confirmed?: boolean } = {},
  ): Promise<void> {
    if (body.scope === 'project' && !body.projectId)
      throw new NovaError('validation', 'projectId is required');
    const layers = await loadLayers(body.projectId);
    const check = checkSettingWrite(body.key, body.value, body.scope, layers);
    if (!check.ok) {
      throw new NovaError(
        check.error === 'managed' ? 'policy_denied' : 'validation',
        check.message,
        {
          details: { reason: check.error },
        },
      );
    }
    const scopeRef = body.scope === 'project' ? body.projectId! : '';
    // A security setting's change is audited with its values (docs/12 §3; ops subscribers).
    const security = isSettingKey(body.key) && SETTINGS[body.key].security === true;
    const before = security ? resolveSetting(body.key as SettingKey, layers).value : undefined;
    const now = new Date().toISOString();
    await db.transaction(async () => {
      await db.orm
        .delete(schema.setting)
        .where(
          and(
            eq(schema.setting.key, body.key),
            eq(schema.setting.scopeKind, body.scope),
            eq(schema.setting.scopeRef, scopeRef),
          ),
        );
      await db.orm.insert(schema.setting).values({
        key: body.key,
        scopeKind: body.scope,
        scopeRef,
        valueJson: JSON.stringify(check.value),
        updatedAt: now,
      });
    });
    await events.emit({
      name: 'settings.changed',
      actor: 'user',
      accountId: accountId ?? undefined,
      payload: {
        key: body.key,
        scope: body.scope,
        ...(security ? { before, after: check.value, confirmed: opts.confirmed === true } : {}),
      },
    });
  }

  // ---- events (contracts/events.md, hub-api §5) -----------------------------------------
  app.get('/api/v1/events', async (req) => {
    requireAuth(req);
    const accountId = await accountOf(req);
    const q = z
      .object({
        after: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    // Account-less (system) events are the owner's (M7 identity review, finding 9).
    return {
      events: await events.since(q.after ?? null, q.limit, {
        accountId,
        systemEvents: isHubOwner(db, accountId),
      }),
    };
  });

  app.get('/api/v1/events/stream', async (req, reply) => {
    requireAuth(req);
    const accountId = await accountOf(req);
    const lastId =
      (req.headers['last-event-id'] as string | undefined) ??
      (req.query as { after?: string }).after ??
      null;
    const owner = isHubOwner(db, accountId);
    return openStream(
      req,
      reply,
      {
        events,
        // Closed with the account when its member is removed.
        trackStream: (end) => {
          const a = trackStream(end);
          const b = holdLive(accountId, end);
          return () => {
            a();
            b();
          };
        },
      },
      // Only this account's events reach the client; account-less system events only the owner.
      (e) => e.accountId === accountId || (!e.accountId && owner),
      // Like the thread stream: replay only after a cursor; without one, live events only
      // (contracts/hub-api.md §5), so a fresh client never receives old history.
      async (send) => {
        if (!lastId) return;
        let cursor: string = lastId;
        for (;;) {
          const page = await events.since(cursor, 500, { accountId, systemEvents: owner });
          for (const e of page) send(e);
          if (page.length < 500) break;
          cursor = page.at(-1)!.id;
        }
      },
    );
  });

  // ---- chat, projects, memory (M1, M2) ------------------------------------------------------
  registerChatRoutes(app, {
    db,
    dataDir,
    events,
    registry,
    router,
    threads,
    chat,
    accountOf,
    trackStream,
    status: (accountId, ids) => requests.status.statusOf(accountId, ids),
  });
  registerProjectRoutes(app, { projects, sources, accountOf });
  registerMemoryRoutes(app, { memory, accountOf });
  registerModelRoutes(app, {
    router: fullRouter,
    readPresets: async () => resolveSetting('models.presets', await loadLayers()).value,
    writePresets: (accountId, items) =>
      writeSetting(accountId, { key: 'models.presets', value: items, scope: 'global' }),
    detect: () => (deps.detect ?? detectLocalServers)(),
    accountOf,
  });
  registerNodeRoutes(app, {
    nodes,
    accountOf,
    novad: devices.nodeRoutes,
    added: addDevice.revoker,
  });
  for (const a of areas) a.register(app);

  void app.register((scoped, _opts, done) => {
    // The session is checked before the upgrade (FR-192): without one the handshake gets 401.
    const sessionFirst = (req: FastifyRequest): Promise<void> => {
      requireAuth(req);
      return Promise.resolve();
    };
    scoped.get('/api/v1/ws', { websocket: true, preValidation: sessionFirst }, (socket, req) => {
      const principal = req.principal;
      const accountId = principal?.accountId;
      if (!principal || !accountId) {
        socket.close(4401, 'token_required');
        return;
      }
      socket.send(JSON.stringify({ type: 'hello', version: config.version }));
      const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify(frame));
      const owner = isHubOwner(db, accountId);
      // Only this account's events reach the socket; account-less system events only the owner.
      const off = events.bus.subscribe('*', (e) => {
        if (e.accountId === accountId || (!e.accountId && owner)) send({ type: 'event', event: e });
      });
      // A removed member's socket closes at once.
      const release = holdLive(accountId, () => socket.close(4401, 'account_closed'));
      // Server-to-client requests for the kinds the client declared (FR-188).
      const q = req.query as { clientSessionId?: string };
      const conn = requests.attachClient({
        accountId,
        deviceId: principal.tokenId,
        clientSessionId: q.clientSessionId ?? null,
        send,
      });
      socket.on('message', (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString('utf8'));
        } catch {
          send({ type: 'error', error: { code: 'validation', message: 'invalid JSON' } });
          return;
        }
        void conn.handle(msg).then((handled) => {
          if (!handled && (msg as { type?: string }).type === 'ping') send({ type: 'pong' });
        });
      });
      socket.on('close', () => {
        off();
        release();
        conn.detach();
      });
    });
    done();
  });

  // ---- web UI -----------------------------------------------------------------------------
  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      index: ['index.html'],
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api/') &&
        req.headers.accept?.includes('text/html')
      ) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({
        error: { code: 'not_found', message: 'not found', retryable: false },
        requestId: req.id,
      });
    });
  } else {
    log.warn('web UI not built; serving the API only', { webDir: config.webDir });
  }

  // Enabled extensions start their workers once everything they call is wired (FR-117).
  void sdk.start();
  return {
    app,
    auth,
    events,
    registry,
    router,
    nodes,
    threads,
    chat,
    projects,
    sources,
    memory,
    runs,
    trust,
    network,
    relay,
    team,
    appAuth,
    managed,
    routes: () => registered,
  };
}

async function authenticate(req: FastifyRequest, auth: AuthService): Promise<Principal | null> {
  const header = req.headers.authorization;
  let token: string | undefined;
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
  else token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return auth.verify(token);
}

export function requireAuth(req: FastifyRequest): Principal {
  if (!req.principal)
    throw new NovaError('token_required', 'sign in to use the Hub', {
      action: 'Open the setup link',
    });
  return req.principal;
}

/**
 * Loopback is not an authorization boundary (FR-192), but Host and Origin checks stop DNS
 * rebinding and cross-site requests from a browser. Requests without Origin (CLI, devices) must
 * still present a token.
 */
function guardHostAndOrigin(
  req: FastifyRequest,
  config: HubConfig,
  extraHosts: ReadonlySet<string> = new Set(),
): void {
  const host = (req.headers.host ?? '').toLowerCase();
  const allowedHosts = allowedHostSet(config);
  for (const h of extraHosts) allowedHosts.add(h);
  if (!allowedHosts.has(host) && !allowedHosts.has(host.replace(/:\d+$/, ''))) {
    throw new NovaError('origin_rejected', 'unexpected Host header');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  const allowedOrigins = new Set([`http://${host}`, `https://${host}`, ...config.allowedOrigins]);
  if (!allowedOrigins.has(origin.toLowerCase()))
    throw new NovaError('origin_rejected', 'cross-origin request refused');
}

function allowedHostSet(config: HubConfig): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '[::1]', config.host.toLowerCase()]);
  if (config.host === '0.0.0.0' || config.host === '::') {
    // Listening on every interface: accept this machine's own names and addresses.
    names.add(hostname().toLowerCase());
    names.add(`${hostname().toLowerCase()}.local`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) names.add(a.family === 'IPv6' ? `[${a.address}]` : a.address);
    }
  }
  for (const o of config.allowedOrigins) {
    try {
      names.add(new URL(o).host.toLowerCase());
      names.add(new URL(o).hostname.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  return names;
}

export type { FastifyReply };
