// Nova's core (ADR-1): one deployable, internally modular. This is the composition root and the
// only module that knows about all the others; each module gets what it needs passed in, and
// nothing outside src/core imports anything but this file.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { CoreError } from './errors.ts';
import { Db, loadMigrations } from './db.ts';
import { Log, addSecretValue } from './log.ts';
import { Profile, SECTIONS, type Section } from './profile.ts';
import { Workspace, workspaceWorker } from './workspace.ts';
import { Verifier, type Checker } from './verify.ts';
import { Ledger, STATES, type LanedWorker, type State, type TaskInput } from './ledger.ts';
import { Setup, type Onboarding } from './setup.ts';
import { detectOs, type OsFamily } from './onboard/detect.ts';
import { discover, realTransport, type DiscoveryTransport } from './onboard/discover.ts';
import { findSources, importSources } from './onboard/sources.ts';
import { backendFor } from './onboard/backend.ts';
import { Extensions } from './extensions.ts';
import { Design, type Scope } from './design.ts';
import { Decisions, RulesProvider, Templates } from './decide.ts';
import { TRIAGE, Triggers, triageRule, type Policy, type RuleInput } from './triggers.ts';
import { Memory, KINDS as MEMORY_KINDS, type Kind as MemoryKind, type MemoryInput, type UserState } from './memory.ts';
import { Receipts } from './receipts.ts';
import { Backups } from './backups.ts';
import { CHARTER, identityOf, render } from './identity.ts';
import { egressOf, info, permits, stricter, type Egress } from './workers.ts';
import { createApi, Raw, Reply, type Route, type Who } from './api.ts';
import { loadIdentity, replaceIdentityKeys } from './mesh/identity.ts';
import { Devices, ONLINE_WINDOW_MS, SESSION_TTL_MS, type Device } from './mesh/devices.ts';
import { Enrollment } from './mesh/enroll.ts';
import { resolvePlacement, type PlacementDevice } from './services/placement.ts';
import { validate } from './services/definition.ts';
import { APPROVER_ONLY, Access, allows, loopbackAddress, sessionCookie, type Listener, type MeshListenerInfo, type Principal } from './mesh/access.ts';
import { SyncLog } from './mesh/sync.ts';
import { MeshRole, nodeRole } from './mesh/promote.ts';
import { DEVICE_CONFIG_SECTIONS, Spokes } from './mesh/spokes.ts';
import { agentTar, joinScript } from './mesh/agent.ts';
import { Vault, type KeyMode, type KeyStore } from './vault.ts';
import { Connectors } from './connectors/index.ts';
import { homeAssistant, type HomeAssistantOptions } from './connectors/home-assistant.ts';
import { Providers } from './providers/registry.ts';
import { Browser, type BrowserOptions } from './browser/worker.ts';
import type { Hub } from './browser/plan.ts';
import { browserRoutes } from './browser/routes.ts';
import { checkers as browserCheckers } from './browser/evidence.ts';
import { Capture, PROMOTE } from './capture/capture.ts';
import { captureRoutes } from './capture/routes.ts';
import { Models, type Hardware } from './models/index.ts';
import { LocalModelProvider, PROVIDER_ID as LOCAL_MODEL_PROVIDER } from './models/decide.ts';
import { wireIngest, type ScreenInput, type Taint } from './ingest/index.ts';
import { NovaComputer, type ComputerOptions } from './computer/index.ts';
import { computerRoutes } from './computer/routes.ts';
import { Coding, type CodingOptions } from './coding/index.ts';
import { codingRoutes } from './coding/routes.ts';
import { Infra, type InfraOptions } from './infra/index.ts';
import { infraRoutes } from './infra/routes.ts';
import { Network, type NetworkOptions } from './network/index.ts';
import { networkRoutes } from './network/routes.ts';
import { secretName } from './providers/types.ts';
import { Resilience } from './resilience/index.ts';
import { FactoryReset } from './resilience/reset.ts';
import { ensureMark } from './resilience/home-mark.ts';
import { connectorWatch, wireRepairs } from './resilience/repairs.ts';
import type { SupervisorLink } from './resilience/link.ts';
import { Changes } from './changes/pipeline.ts';
import { Checkpoints, dropPartials, finishStaged, stagedPending, takeCheckpoint } from './resilience/checkpoints.ts';
import { Restarter } from './resilience/restart.ts';
import { stopChildren } from './children.ts';
import { Foundry } from './changes/foundry.ts';
import { Self } from './self.ts';
import { CODE_ROOT } from './resilience/sandbox.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

// A setting's key as the inbox takes it in a config change (mesh/spokes.ts).
const DEVICE_CONFIG_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

export { render as renderIdentity } from './identity.ts';
export { permits } from './workers.ts';
export { ENVELOPE_VERSION } from './envelope.ts';
export { TERMINAL } from './ledger.ts';
export type { Brief, Evidence, Report } from './envelope.ts';
export type { Worker, Egress } from './workers.ts';
export type { Checker } from './verify.ts';
export type { Lane, LanedWorker, Task } from './ledger.ts';
// The design-system schema and its checks, for the token lint and the package check (scripts/).
// The mesh's wire format and the limiter, shared with the device agent (src/device) and sync.
export * from './mesh/wire.ts';
export { SlidingWindowLimiter } from './mesh/limiter.ts';
export { KINDS as DEVICE_KINDS, ROLE_OF, SESSION_TTL_MS } from './mesh/devices.ts';
export { JOIN_REVEAL_TTL_MS, JOIN_APPROVE_TTL_MS, rateKey } from './mesh/enroll.ts';
export { PURPOSES, PURPOSE_WORDS, WORKLOAD_PURPOSES, allowedPurposes, checkPurposes, defaultPurposes, fixedPurposes, mayRunWork, purposeChange } from './mesh/purposes.ts';
export type { Purpose, PurposeChange } from './mesh/purposes.ts';
export { BROWSER_TASK_HEADER, PUBLIC_PATHS, SESSION_COOKIE, allows, fromBrowserTask, isConsole, loopbackAddress, loopbackHost } from './mesh/access.ts';
export { DEVICE_CONFIG_SECTIONS, INBOX_KINDS, MAX_BATCH as INBOX_MAX_BATCH } from './mesh/spokes.ts';
export { RUNTIME_FILES, agentFiles, agentTar, joinScript, tar } from './mesh/agent.ts';
export type { Device, Kind as DeviceKind, Role as DeviceRole, MeshState } from './mesh/devices.ts';
export type { JoinRequest, Pairing } from './mesh/enroll.ts';
export type { Listener, MeshListenerInfo, Principal, Scope } from './mesh/access.ts';
export type { MeshIdentity } from './mesh/identity.ts';
// Hub, standby and sync (M4c): the role file a standby is enrolled with, and this node's keys.
export { loadIdentity } from './mesh/identity.ts';
export { ROLE_FILE, readRole, writeRole } from './mesh/replica.ts';
export type { RoleFile } from './mesh/replica.ts';
export { REPLICATED, NOT_JOURNALLED } from './mesh/sync.ts';
export type { Who } from './api.ts';
// Providers (M5a): the registry's chat handle for Era 2's runner, and the stand-ins' signing helpers.
export type { ChatHandle } from './providers/registry.ts';
export { signatureHeader as n8nSignature, SIGNATURE_HEADER as N8N_SIGNATURE_HEADER } from './providers/n8n.ts';
export { originHost } from './api.ts';
export { TOKENS, TOKEN_NAMES, cssVar, contrast, validatePackage, generateCss, BUILTIN_DIR, DEFAULT_DESIGN_SYSTEM, STARTERS, LIVE_CHECKS, liveCheck, looks, contrastNudge, applyNudge, MOTION_MIN_MS, MOTION_MAX_MS, TRANSITION_TOKENS, overshoots } from './design.ts';
// The vault and connectors (M5b): Era 2's Gmail keeps its secrets in the vault and registers as a connector.
export { Vault, FILE_KEY_NOTICE, SECRET_SCHEME, secretRef, keyMode, fileKeyStore, secretToolKeyStore, macKeyStore, windowsKeyStore, platformKeyStore } from './vault.ts';
export type { KeyMode, KeyStore, Run as KeyCommandRunner, VaultStatus } from './vault.ts';
export { addressEgress, secretPrefix } from './connectors/index.ts';
export type { Connector, ConnectorContext, ConnectorFactory, ConnectorStatus, ConnectorView } from './connectors/index.ts';
export { HA_ID, HA_MANIFEST, DEFAULT_TIER3, tokenIssuer } from './connectors/home-assistant.ts';
export { redactText } from './log.ts';
// Resilience (M7b): the supervisor's link and shared pieces (src/supervisor imports only this file).
export { ipcLink } from './resilience/link.ts';
export type { SupervisorLink, SupervisorState, SupervisorProblem, ReleaseSlot, Stage as DeployStage, ProbeLine, ServerMode } from './resilience/link.ts';
export { PLAYBOOKS } from './resilience/playbooks.ts';
export { CODE_ROOT, copyHome, smoke, startSandbox, sandboxEnv } from './resilience/sandbox.ts';
export type { Sandbox, ProbeResult } from './resilience/sandbox.ts';
export { restoreInto, backupFiles, sha256File, openEncrypted } from './resilience/backup.ts';
// Factory reset (M7 amendment §2): finished at start, before the database opens (server.js too).
export { RESET_MARKER, RESET_REPORT, finishReset, homeEntries } from './resilience/reset.ts';
export { HOME_MARK, ensureMark } from './resilience/home-mark.ts';
export type { ResetReport } from './resilience/reset.ts';
export { makeScratch, dropScratch } from './resilience/scratch.ts';
export type { Manifest as BackupManifest } from './resilience/backup.ts';
export { restoreBackup, loadMigrations } from './db.ts';
// Checkpoints (M7 amendment §1): the supervisor takes one before a release switch on the stopped
// home; the server applies a staged restore before anything opens the home.
export { takeCheckpoint, listCheckpoints, finishStaged, stagedPending, KEEP_AUTO, RETENTION as CHECKPOINT_RETENTION } from './resilience/checkpoints.ts';
export type { CheckpointView, CheckpointManifest } from './resilience/checkpoints.ts';
// Nova's own entries in a home, by name: what checkpoints, restore and factory reset may touch.
export { NOVA_ENTRIES, isNovaEntry, foreignEntries } from './resilience/entries.ts';
// Every process Nova starts, so none outlives an in-place restart (Era 2's commands register too).
export { trackChild } from './children.ts';
// Services (M10e): the definition, the driver interface, the Service Manager.
export * from './services/index.ts';
// Onboarding (M10f): device detection, the backend words, discovery and import sources.
export { OS_FAMILIES, OS_WORDS, detectOs, factsWords, recommendedHubPurposes, standInOs } from './onboard/detect.ts';
export type { DeviceFacts, OsFamily } from './onboard/detect.ts';
export { backendFor } from './onboard/backend.ts';
export type { BackendSummary } from './onboard/backend.ts';
export { LOCAL_PORTS as DISCOVERY_PORTS, SERVICES as DISCOVERY_SERVICES, discover, loopbackTransport, realTransport, transportFromEnv } from './onboard/discover.ts';
export type { Discovery, DiscoveryTransport, Found } from './onboard/discover.ts';
export { decodeMessage as decodeMdns, encodeQuery as encodeMdnsQuery, encodeResponse as encodeMdnsResponse } from './onboard/mdns.ts';
export type { Answer as MdnsAnswer } from './onboard/mdns.ts';
export { findSources, importSources } from './onboard/sources.ts';
export type { Imported, Source as ImportSource } from './onboard/sources.ts';
export { FIRST_ACTIONS, firstAction } from './onboard/first.ts';
export type { FirstAction, FirstView } from './onboard/first.ts';
// The ingest gate (Amendment 2026-10-30-C Part 3): what Era 2's agent loop screens with, escapes
// with, and says when something is blocked.
export { Ingest, BLOCK_LINE, DEFAULT_LINK_CAPS, PROTOCOL_NAMES, KIND_WORDS, cleanOrigin, escapeProtocol, fold, wrapData } from './ingest/index.ts';
export type { Screened, Source as IngestSource, SourceKind, Taint, Verdict, Candidate as MemoryCandidate, Hold } from './ingest/index.ts';
// Grounding: what this Nova is, from its own registries, for the chat agent's briefing and tools.
export { IMPORT_DIR } from './self.ts';
export type { Self, Era2State } from './self.ts';
// The eval harness (Amendment 2026-10-31-B Part 4): graders, suites, the model-swap scorecard.
export * as evals from './evals/index.ts';
// Hard caps on autonomy cost (Amendment 2026-10-31-B Part 5): ceilings, the meter, the loop detector.
export { Caps, Meter, DEFAULT_LIMITS, LOOP, CHARS_PER_TOKEN, SPEND_DIR, signature, weightOf, capsRoutes } from './caps/index.ts';
export type { Limits, Ceilings, Spend, Stop } from './caps/index.ts';

export interface CoreOptions {
  home: string;
  version: string;
  trustedOrigin: (host: string) => boolean;
  detectedTimezone?: string;
  // Where the chat model sends conversations, so setup can say so truthfully.
  chat?: { program: string; egress: Egress };
  // Workers from outside the core (Era 2's chat-run), run through the same ledger and gates.
  workers?: LanedWorker[];
  // Confirmation checkers by system, for systems Nova can read itself ("nova-sessions").
  confirmations?: Record<string, Checker>;
  // Where the built-in design systems live; defaults to design-systems/ in the repo.
  designSystems?: string;
  // The mesh listener, when there is one: where devices reach Nova, and what carries it.
  mesh?: MeshListenerInfo | null;
  // Where the vault's key lives (vault.ts): NOVA_VAULT_KEY by default; tests inject a keychain.
  vault?: { mode?: KeyMode; keychain?: ((account: string) => KeyStore | null) | null };
  // Nova Computer (M10a), for tests: another adapter than Docker, whose home folder a project may
  // never be, which addresses the egress proxy counts as public, smaller disk caps, and a label
  // for the containers.
  computer?: Pick<ComputerOptions, 'computer' | 'userHome' | 'egressAllow' | 'limits' | 'labels'>;
  // Coding through chat (M10c), for tests: whose home folder a repository may never be, and shorter
  // timeouts for the test run and the preview.
  coding?: Pick<CodingOptions, 'userHome' | 'testTimeoutS' | 'previewTimeoutS'>;
  // Infrastructure through chat (M10d), for tests: the PATH the plan/apply tool is found on (the
  // stand-in's), whose home folder a project may never be, and the tool's timeout.
  infra?: Pick<InfraOptions, 'path' | 'userHome' | 'timeoutS'>;
  // Networking through chat (M10d), for tests: the dead-man's switch's window in milliseconds.
  network?: Pick<NetworkOptions, 'windowMs' | 'target' | 'retryMs'>;
  // The ports of Nova's own listeners (console and mesh), which a browser task never reaches.
  hubPorts?: () => number[];
  // How the browser worker starts a browser: Chromium, or a stand-in in tests.
  browserLaunch?: BrowserOptions['launch'];
  // Home Assistant's reconnect pauses and timeouts (tests shorten them).
  homeAssistant?: HomeAssistantOptions;
  // The model command Era 2 chats with (agent_cmd, agent_egress): the custom-cli provider (M5a).
  agent?: { command: string; egress: Egress };
  // A secret by name (secret://NAME), for providers that need one; the vault (M5b) answers it.
  secrets?: (name: string) => string | null;
  // Capture (M6a): how often the adapters pull (NOVA_CAPTURE_POLL_MS, else 10 s), and the fetch
  // they use (tests).
  capture?: { pollMs?: number; fetch?: typeof fetch };
  // The local model manager (M6b): where the hub's Ollama answers by default, and (tests) a fixed
  // hardware reading and quicker watch and wake polls.
  models?: { ollamaUrl?: string; hardware?: () => Promise<Hardware>; watchMs?: number; wakePollMs?: number };
  // The supervisor that started this server, when one did (resilience/link.ts: ipcLink).
  supervisor?: SupervisorLink | null;
  // Onboarding (M10f): a stand-in OS detection (NOVA_DETECT_OS), discovery's transport (stand-ins on
  // loopback in tests; the real one sends one multicast query, only when the person asks), and the
  // person's own home folder, where import sources are found.
  onboarding?: { os?: OsFamily | null; transport?: DiscoveryTransport | null; userHome?: string; platform?: string };
  // Resilience (M7b), for tests: the clock watch's monotonic time, and the restore drill's sandbox.
  resilience?: { monotonic?: () => number; drill?: { root?: string; env?: Record<string, string>; timeoutMs?: number }; lookup?: (host: string) => Promise<unknown> };
  // This process is a sandbox copy started by the change pipeline (M7a, NOVA_SANDBOX=1): it runs
  // none of the hub's outside work (connectors, capture, models, the heartbeat), takes no changes,
  // and answers the sandbox routes.
  sandbox?: boolean;
  // The change pipeline (M7a), for tests: the monotonic clock its canary windows are measured on.
  changes?: { monotonic?: () => number };
  // Checkpoints (M7 amendment), for tests: the free space where they go.
  checkpoints?: { free?: (dir: string) => number | null };
  // Factory reset (M7 amendment §2), for tests: how long the hub waits for devices to hear it, and
  // a hook before each step of finishing one (to stop it part way, as a power cut would).
  reset?: { tellMs?: number; step?: (what: string) => void };
  // What this instance is for (NOVA_INSTANCE): preview, production or development. Said in the
  // agent's briefing.
  instance?: string;
  now?: () => Date;
}

export type Core = ReturnType<typeof createCore>;

export function createCore(o: CoreOptions) {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  // A restore or a factory reset staged before the last stop is applied first, before the database
  // opens; a checkpoint stopped part-way is dropped. A reset that can't finish throws: a half-reset
  // Nova never runs.
  // Nova's mark on its home (home-mark.ts): written when the folder is clearly Nova's.
  if (!o.sandbox) ensureMark(o.home, { now });
  const staged = o.sandbox ? null : finishStaged(o.home, { vaultAt: (home) => new Vault({ home, ...(o.vault ?? {}) }), now, reset: { ...(o.vault ? { vault: o.vault } : {}), ...(o.reset?.step ? { step: o.reset.step } : {}), now } });
  if (!o.sandbox) dropPartials(o.home);
  const db = new Db(join(o.home, 'nova.db'));
  // An automatic checkpoint before a database upgrade, beside the pre-upgrade copy: one that can't
  // be taken stops the upgrade (and so the start), with the reason.
  const migration = db.migrate({
    backupDir: join(o.home, 'backups'), now,
    ...(o.sandbox ? {} : { before: (from: number) => { takeCheckpoint({ home: o.home, db, kind: 'auto', reason: `Before upgrading the database from version ${from}`, version: o.version, now, ...(o.checkpoints?.free ? { free: o.checkpoints.free } : {}) }); } }),
  });
  const log = new Log(db, join(o.home, 'logs', 'nova.log'), now);
  // What a staged restore couldn't do (or did, with a full disk) is the person's to know.
  for (const p of staged?.problems ?? []) log.problem('resilience', p);
  // Hub or standby, decided before anything writes: a standby copies the hub's sync log instead
  // of recording its own writes (mesh/promote.ts).
  const place = nodeRole(db, o.home);
  let meshRole: MeshRole | null = null;
  log.local = () => (meshRole ? meshRole.role() : place.role) !== 'hub';
  const profile = new Profile(db, now);
  const workspace = new Workspace(join(o.home, 'workspace'));
  const verifier = new Verifier(workspace, now);
  for (const [system, check] of Object.entries(o.confirmations ?? {})) verifier.registerConfirmation(system, check);
  // Browser work with takeover (M5c): a worker of its own, and the checks for what it proves.
  // Its browser runs here, so it is told where Nova itself listens: this machine's addresses and
  // names, at the console's and the mesh listener's ports (browser/plan.ts, `Hub`).
  const hubAddress = (): Hub => ({
    ports: o.hubPorts?.() ?? [],
    hosts: [
      hostname(),
      ...(o.mesh?.publicUrl ? [(() => { try { return new URL(o.mesh!.publicUrl).hostname; } catch { return ''; } })()] : []),
      ...Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address)),
    ].filter(Boolean),
  });
  // Page reads are screened by the ingest gate (wired below) as they are taken.
  const browser = new Browser({ home: o.home, log, now, hub: hubAddress, ...(o.browserLaunch ? { launch: o.browserLaunch } : {}), screen: (r) => ingest.screen({ text: r.text, source: { kind: 'web', origin: r.origin, ref: r.ref } }) });
  const browserChecks = browserCheckers(o.home);
  verifier.registerKind('screenshot', browserChecks.screenshot);
  verifier.registerKind('url', browserChecks.url);
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules, now });
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(workspace, join(o.home, 'workers', 'workspace')), templates.worker, browser.worker, ...(o.workers ?? [])], defaultPrivacy: () => profile.privacyDefault(), now });
  templates.bind(ledger);
  browser.bind(ledger);
  // Remote decision providers (JevProvider) are registered only once configured; local-only skips them anyway.
  const decisions = new Decisions({ templates, providers: [rules], privacy: () => profile.privacyDefault(), log });
  const triggers = new Triggers({
    db, log, ledger, templates, rules, decisions, now, sandbox: o.sandbox === true,
    policy: () => profile.section('policy') as Policy,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
  });
  // Onboarding's view of the rest of Nova (M10f). Everything here is read when setup asks, not now.
  const userHome = o.onboarding?.userHome ?? homedir();
  const deviceOs = o.onboarding?.os ?? detectOs();
  const onboarding: Onboarding = {
    os: () => deviceOs,
    hardware: async () => (models ? await models.hubHardware() : null),
    hubPurposes: () => devices.find(meshIdentity.id)?.purposes ?? [],
    setHubPurposes: (p) => devices.setPurposes(meshIdentity.id, p, { confirm: true, approved: true, by: 'setup' }).device.purposes,
    discover: (scope) => discover({ scope, transport: o.onboarding?.transport ?? realTransport(), now }),
    sources: () => findSources(userHome, o.onboarding?.platform ?? process.platform),
    import: (picked) => importSources(picked, {
      screen: async (text, origin) => { const r = await ingest.screen({ text, source: { kind: 'file', origin } }); return { verdict: r.verdict, taint: r.taint }; },
      candidate: (c) => { ingest.candidate({ op: 'remember', kind: c.kind, content: c.content, source: c.source, taint: c.taint as Taint[] }); },
      kept: () => new Set([...memory.active().map((r) => r.content.toLowerCase()), ...ingest.candidates().filter((c) => c.op === 'remember' && c.content).map((c) => c.content!.toLowerCase())]),
    }, { userHome, now: now() }),
  };
  const setup = new Setup({ profile, ledger, now, onboarding, ...(o.detectedTimezone ? { detectedTimezone: o.detectedTimezone } : {}), ...(o.chat ? { chat: o.chat } : {}) });
  const extensions = new Extensions({ db, home: o.home, novaVersion: o.version, now });
  const design = new Design({ extensions, profile, ...(o.designSystems ? { dir: o.designSystems } : {}) });
  const backups = new Backups({ dir: join(o.home, 'backups'), log });
  const memory = new Memory({ db, home: o.home, now, afterForget: (ids, records) => backups.forget('memory', ids, records.map((r) => r.content)) });
  const receipts = new Receipts({ db, log, now });
  for (const p of design.ensureBuiltins()) log.problem('design', p);
  // Providers (M5a): each enabled one is a ledger worker. A model on one of the person's own
  // devices counts as local.
  const meshHosts = () => new Set([
    ...(o.mesh?.publicUrl ? [o.mesh.publicUrl] : []),
    ...db.all<{ address: string | null }>("SELECT address FROM device WHERE trust = 'trusted' AND address IS NOT NULL").map((d) => d.address!),
  ].map((a) => { try { return new URL(a.includes('://') ? a : `http://${a}`).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } }).filter(Boolean));
  // The vault (M5b): secrets by name, encrypted at rest. Providers name theirs secret://NAME, kept
  // as provider/NAME; `o.secrets` (server.js: NOVA_SECRET_<NAME>) is a fallback for development
  // and tests only, and anything it answers is redacted like a vault value.
  const vault = new Vault({ home: o.home, ...(o.vault ?? {}) });
  const providerSecret = (name: string): string | null => {
    let v: string | null = null;
    try { v = vault.get(`provider/${name}`); } catch { /* a vault that won't open: its problem shows in health */ }
    if (v === null && o.secrets) {
      v = o.secrets(name);
      if (v) addSecretValue(v);
    }
    return v;
  };
  // The model manager (M6b) is made once the device registry exists (below); providers reach it
  // through these, for a provider set to a role and for cloud budgets.
  let models: Models | null = null;
  // Made once the ledger's other parts exist (below); capture asks it whether retention may run.
  let resilience: Resilience | null = null;
  const providers = new Providers({
    db, log, home: o.home, workspace, extensions, ledger, verifier, receipts, profile, now,
    custom: o.agent, secret: providerSecret, meshHost: (h) => meshHosts().has(h),
    fire: (input) => triggers.fire(input),
    models: { infer: (r) => models!.infer(r), probe: (role) => models!.probe(role), cloudName: () => models?.cloud()?.name ?? null },
    budget: (brief) => models?.budgetBlock(brief.task_id, brief.constraints.max_cost_usd) ?? null,
  });
  // The device mesh: this node's keys, the registry, enrollment, and who may do what.
  const meshInfo = o.mesh ?? null;
  const publicUrl = () => meshInfo?.publicUrl ?? null;
  const meshIdentity = loadIdentity(o.home, { now, warn: (m) => log.problem('mesh', m), adopt: place.file?.device_id ?? null });
  const devices = new Devices({ db, log, identity: meshIdentity, now, publicUrl });
  if (place.role === 'hub') devices.ensureHub();
  // The local model manager (M6b): hardware, roles, downloads, the inference API, wake, budgets.
  models = new Models({
    db, log, profile, ledger, verifier, receipts, devices, now,
    hubName: () => devices.find(meshIdentity.id)?.name ?? 'This hub',
    ...(o.models?.ollamaUrl ? { ollamaUrl: o.models.ollamaUrl } : {}),
    ...(o.models?.hardware ? { hardware: o.models.hardware } : {}),
    ...(o.models?.watchMs ? { watchMs: o.models.watchMs } : {}),
    ...(o.models?.wakePollMs ? { wakePollMs: o.models.wakePollMs } : {}),
    diskPath: o.home,
    meshHost: (h) => meshHosts().has(h),
    secret: (v) => { const n = secretName(v); return n ? providerSecret(n) : null; },
    // The person is told the way proactive messages go: triaged, quiet hours kept.
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'models', name: 'Local models', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('models', 'Nova couldn’t tell you about waiting work.', { error: (e as Error).message })); },
  });
  ledger.workers.set(models.worker.id, models.worker);
  // System 1 on the local sorting model (ADR-7): asked first once one is assigned; the rules answer
  // when it isn't, or can't.
  // The person's policy still binds it: what the triage rule decides from a hard setting (a category
  // turned off, quiet hours for a message) a model's answer may not overturn; it escalates instead.
  const triageGuard = (t: { template_id: string }, inputs: Record<string, unknown>, answers: Record<string, unknown>) => {
    if (t.template_id !== TRIAGE.template_id) return null;
    const hard = inputs.category_off === true || (inputs.quiet_hours === true && inputs.action === 'message');
    const rule = triageRule(inputs as never).answers.decision;
    return hard && answers.decision !== rule ? `your settings say “${rule}” here (${inputs.category_off ? 'this is turned off' : 'quiet hours'}).` : null;
  };
  decisions.register(new LocalModelProvider({ infer: (r) => models!.infer(r), ready: (t) => models!.decidesWithModel(rules.has(t.template_id)), guard: triageGuard }), { first: true });
  // The ingest security gate (Amendment 2026-10-30-C Part 3): every read of outside content is
  // screened before a model acts on it. The Noul screen is the local sorting model only, and the
  // outbound guard knows the vault's values, memory and the standing files.
  const { ingest } = wireIngest({
    db, log, home: o.home, now, templates, decisions, ledger, verifier,
    ready: () => models!.decidesWithModel(false), providerId: LOCAL_MODEL_PROVIDER,
    infer: (r) => models!.infer(r),
    secrets: () => { try { return vault.list().map((n) => vault.get(n)).filter((v): v is string => typeof v === 'string'); } catch { return []; } },
    memory: () => memory.active().map((r) => r.content),
  });
  // Nova Browser (M10b): sign-ins from the vault, the co-pilot on the local sorting model (Noul,
  // through the decision stack, forced local-only), site templates through the template path, and
  // the ingest screen for every dialog and every co-pilot input.
  browser.wire({
    db, vault, templates, rules, decisions,
    screen: async (text, origin, ref) => {
      const r = await ingest.screen({ text, source: { kind: 'web', origin, ref } });
      return { id: r.id, verdict: r.verdict, flags: r.flags, extract: r.extract };
    },
    copilotReady: () => models!.decidesWithModel(false), providerId: LOCAL_MODEL_PROVIDER,
  });
  // Nova Computer (M10a): workspaces as containers on this machine, each action a ledger task; a
  // command's output is screened by the ingest gate as tool output.
  const computer = new NovaComputer({
    db, log, home: o.home, ledger, verifier, now, privacy: () => profile.privacyDefault(),
    screen: (r) => ingest.screen({ text: r.text, source: { kind: 'tool', origin: r.origin, ref: r.ref } }),
    ...(o.computer ?? {}),
  });
  ledger.workers.set(computer.worker.id, computer.worker);
  // Coding through chat (M10c): a coding request as a run of ledger tasks (write, check, merge),
  // its agent through the provider registry, its worktree Nova's own, its merge tier 3. The person is
  // told as a proactive message, through the trigger engine.
  const coding = new Coding({
    db, log, home: o.home, ledger, verifier, providers, now, privacy: () => profile.privacyDefault(),
    ...(o.coding ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'coding', name: 'Coding', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('coding', 'Nova couldn’t tell you about a coding run.', { error: (e as Error).message })); },
  });
  ledger.workers.set(coding.worker.id, coding.worker);
  const enroll = new Enrollment({ db, log, devices, identity: meshIdentity, now, publicUrl });
  const access = new Access({ devices, mesh: meshInfo });
  // Hub, standby and sync (M4 plan §3).
  const sync = new SyncLog({ db, log, home: o.home, node: meshIdentity.id, now });
  memory.onForgetDone((records) => sync.forgotten(records.map((r) => r.content)));
  // A standby gets the vault sealed through sync.
  sync.vault = vault;
  vault.on('change', () => {
    try { sync.vaultChanged(); } catch (e) { log.problem('sync', 'Nova couldn’t record a change to its vault for the standby.', { detail: (e as Error)?.stack ?? String(e) }); }
  });
  meshRole = new MeshRole({
    db, log, home: o.home, now, publicUrl, identity: meshIdentity, devices, access, sync, ledger, verifier, file: place.file,
    becameHub: () => startHub(), becameStandby: () => stopHub(),
    forgotten: (rows) => memory.forgottenElsewhere(rows),
    forget: (id, by) => { try { memory.forget(id, by); return true; } catch (e) { if (e instanceof CoreError && e.code === 'not_found') return false; throw e; } },
    failoverAfterS: () => { const v = profile.get<number>('mesh', 'auto_failover_after_s'); return typeof v === 'number' && v > 0 ? v : null; },
    // The hub was factory reset: this standby wipes its copy (resilience/reset.ts).
    hubReset: (notice) => reset.standbyWipe(notice),
  });
  const role = meshRole;
  // Checkpoints (M7 amendment §1) and restarting in place, for a restore (and a factory reset).
  const restarter = new Restarter({ supervisor: o.supervisor ?? null, log });
  const checkpoints = new Checkpoints({
    db, log, home: o.home, version: o.version, now, ledger, verifier, vault,
    vaultAt: (home) => new Vault({ home, ...(o.vault ?? {}) }),
    hubId: () => meshIdentity.id, role: () => role.role(), schema: () => loadMigrations().at(-1)?.version ?? 0, restarter,
    ...(o.checkpoints?.free ? { free: o.checkpoints.free } : {}),
  });
  ledger.workers.set(checkpoints.worker.id, checkpoints.worker);
  // Infrastructure through chat (M10d): plan (tier 1), then apply (tier 3) of exactly the reviewed
  // plan, inside the project's budget, after a checkpoint. Alerts are problems and messages.
  const infra = new Infra({
    db, log, home: o.home, ledger, verifier, vault, now, privacy: () => profile.privacyDefault(),
    checkpoint: (reason) => checkpoints.auto(reason),
    ...(o.infra ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'infra', name: 'Infrastructure', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('infra', 'Nova couldn’t tell you about an infrastructure run.', { error: (e as Error).message })); },
  });
  ledger.workers.set(infra.worker.id, infra.worker);
  // Networking through chat (M10d): snapshot and diff (tier 1), apply (tier 3) after a checkpoint,
  // then the dead-man's switch on the device mesh: no contact from the person's devices within the
  // window (mesh.contact_window_s), and Nova puts the snapshot back by itself.
  const network = new Network({
    db, log, home: o.home, ledger, verifier, vault, devices, now, privacy: () => profile.privacyDefault(),
    checkpoint: (reason) => checkpoints.auto(reason),
    windowS: () => { const v = profile.get<number>('mesh', 'contact_window_s'); return typeof v === 'number' ? v : 300; },
    contactKinds: () => profile.get<unknown>('mesh', 'contact_kinds'),
    ...(o.network ?? {}),
    notify: (key, text) => { void triggers.fire({ class: 'proactive', source: 'network', name: 'Network', payload: { key }, dedup_key: key, action: { kind: 'message', text } }).catch((e) => log.warn('network', 'Nova couldn’t tell you about a network change.', { error: (e as Error).message })); },
  });
  ledger.workers.set(network.worker.id, network.worker);
  // Every forget reaches each checkpoint (and a restore that is staged).
  backups.also((table, ids, words) => checkpoints.forget(table, ids, words));
  // The change pipeline and the foundry (M7a): changes to Nova go through gates, never live edits.
  const changes = new Changes({
    db, log, ledger, verifier, home: o.home, now, sandbox: o.sandbox === true, testClock: process.env.NOVA_TEST_CLOCK === '1',
    // An automatic checkpoint before a change goes live: none, and it doesn't ship.
    checkpoint: (reason) => { checkpoints.auto(reason); },
    routes: () => routes, health: () => health(), hubDevice: () => meshIdentity.id, privacy: () => profile.privacyDefault(),
    knownDevice: (id) => id === meshIdentity.id || devices.find(id)?.trust === 'trusted',
    // The canary's window on a clock that only moves forward. An injected clock (tests) is the
    // only clock there is, so it stands in unless a test gives one of its own.
    ...(o.changes?.monotonic ? { monotonic: o.changes.monotonic } : o.now ? { monotonic: () => now().getTime() } : {}),
    live: {
      db, extensions, design, profile, triggers, templates, ledger, now, novaVersion: o.version,
      timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
      workerEgress: (owner) => { const w = ledger.workers.get(owner); return w ? w.egress : null; },
    },
  });
  ledger.workers.set(changes.worker.id, changes.worker);
  const foundry = new Foundry({
    home: o.home, ledger, changes, receipts, privacy: () => profile.privacyDefault(),
    infer: (r) => models!.infer(r) as never, chat: () => providers.chat(),
  });
  ledger.workers.set(foundry.worker.id, foundry.worker);
  // Capture (M6a): consent, storage on the hub, classification, promotion; Screenpipe pulled, and
  // device agents' capture events through the inbox below.
  const capture = new Capture({
    db, log, profile, memory, backups, decisions, templates, now,
    self: () => meshIdentity.id,
    deviceName: (id) => devices.find(id)?.name ?? null,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
    privacy: () => profile.privacyDefault(),
    meshHosts: () => [...meshHosts()],
    fire: (topic, payload, key) => triggers.connectorEvent('capture', topic, payload, key),
    proposer: () => (models!.decidesWithModel(rules.has(PROMOTE.template_id)) ? LOCAL_MODEL_PROVIDER : null),
    // Captured text is screened before triage reads it: audio and meetings as transcripts, the rest
    // as screen text (OCR).
    screen: (r) => ingest.screen({ text: r.text, source: { kind: r.kind === 'audio' || r.kind === 'meeting' ? 'transcript' : 'ocr', origin: r.origin } }),
    pollMs: o.capture?.pollMs ?? (Number(process.env.NOVA_CAPTURE_POLL_MS) || 10_000),
    retentionHold: () => resilience?.retentionHeld() ?? null,
    secrets: vault,
    ...(o.capture?.fetch ? { fetch: o.capture.fetch } : {}),
  });
  // A forgotten memory takes the capture it was promoted from with it; on a standby, what the hub
  // forgot or swept is cleaned from this node's backups too.
  memory.onForget((records) => capture.memoryForgotten(records));
  sync.forgetting.set('capture_event', (rows) => capture.forgottenElsewhere(rows));
  // Computers' device agents (M4b): heartbeats, the inbox their queues flush into, the runtime.
  const configRow = (section: string, key: string) => db.get<{ value: string; updated_at: string }>('SELECT value, updated_at FROM profile WHERE section = ? AND key = ?', section, key);
  // A setting's version: its time and value together, so two changes in one millisecond differ.
  const configVersion = (r: { value: string; updated_at: string }) => createHash('sha256').update(`${r.updated_at}\0${r.value}`).digest('hex').slice(0, 16);
  // A device note's first screen, from the check before the inbox writes, reused when it is kept.
  const noteScreens = new WeakMap<object, ReturnType<typeof ingest.screenNow>>();
  const spokes = new Spokes({
    db, log, devices, identity: meshIdentity, now, version: o.version,
    effects: {
      task: (d, key, body) => {
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'device', ref: d.id }, idempotency_key: `device:${d.id}:${key}` });
        triggers.reactive(task, `device:${d.id}`);
        return task;
      },
      // A device's note is outside content: it never becomes memory without the person's OK
      // (Amendment 2026-10-30-C Part 3.6). Every one waits as a memory candidate, out of every
      // prompt, the same queue as memory from a conversation that read outside content.
      memory: (d, body) => {
        const content = String((body as { content?: unknown }).content ?? '');
        const kind = (body.kind ?? 'fact') as MemoryKind;
        const first = noteScreens.get(body) ?? ingest.screenNow({ text: content, source: { kind: 'connector', origin: `device:${d.id}` } });
        return { id: ingest.candidate({ op: 'remember', kind, content, source: `device:${d.id}`, taint: [first.taint] }) };
      },
      // A device's note is screened by Nova's own checks before it is kept (the inbox can't wait for
      // a model): one that tries to give instructions is refused.
      screenNote: (d, body) => {
        const s = ingest.screenNow({ text: String((body as { content?: unknown }).content ?? ''), source: { kind: 'connector', origin: `device:${d.id}` } });
        noteScreens.set(body, s);
        return s.verdict === 'block' ? 'Nova didn’t keep this note: it looked like it was trying to give instructions.' : null;
      },
      capture: (d, key, body) => capture.fromDevice(d, key, body),
      config: {
        read: (section, key) => { const r = configRow(section, key); return r ? { value: JSON.parse(r.value), version: configVersion(r) } : null; },
        write: (section, key, value) => { profile.set(section as Section, key, value, 'settings'); return configVersion(configRow(section, key)!); },
      },
    },
  });

  // Connectors (M5b): Home Assistant is built in; Era 2's Gmail registers itself (server.js).
  const connectors = new Connectors({
    extensions, vault, triggers, log, now,
    privacy: () => profile.privacyDefault(),
    meshHosts: () => devices.list().flatMap((d) => { try { return d.address ? [new URL(d.address).hostname.replace(/^\[|\]$/g, '')] : []; } catch { return []; } }),
    delegate: (owner, input) => {
      const task = ledger.create({ ...input, owner, origin: { kind: 'user' } } as TaskInput);
      triggers.reactive(task, `connector:${owner}`);
      return task;
    },
    addWorker: (w) => { ledger.workers.set(w.id, w); },
    addConfirmation: (system, check) => verifier.registerConfirmation(system, check),
  });
  connectors.register(homeAssistant(o.homeAssistant));
  // Resilience (M7b): nightly backups and the restore drill as ledger work, repair playbooks, the
  // clock watch, and what the supervisor says.
  resilience = new Resilience({
    db, log, home: o.home, version: o.version, profile, ledger, verifier, triggers, vault, backups, now,
    migrations: () => loadMigrations(), supervisor: o.supervisor ?? null,
    ...(o.resilience?.monotonic ? { monotonic: o.resilience.monotonic } : {}), ...(o.resilience?.drill ? { drill: o.resilience.drill } : {}),
  });
  const keep = resilience;
  ledger.workers.set(keep.worker.id, keep.worker);
  // Stops the work: the ledger takes nothing new, every child process stops, running work gets up to
  // `boundMs` to finish (before an in-place restart, a quit, or a factory reset's wipe).
  async function stopWork(boundMs = 5000) {
    ledger.halt('Nova is restarting.');
    await stopChildren(Math.min(3000, boundMs));
    await Promise.race([ledger.idle(), new Promise((r) => setTimeout(r, boundMs).unref())]);
  }
  // Factory reset (M7 amendment §2): the export, the confirmation's list, telling devices, staging.
  const reset = new FactoryReset({
    home: o.home, db, log, version: o.version, now, vault, nightly: keep.nightly, memory, devices, access, spokes, role,
    emit: (event, data) => bus.emit('event', event, data),
    // Restart in place (resilience/restart.ts): the next start finishes the wipe.
    restarter, restorePending: () => stagedPending(o.home), setupDone: () => setup.view().done,
    relayUsed: () => { try { return providers.view('relay').enabled || !!db.get("SELECT 1 FROM task WHERE owner = 'relay' LIMIT 1"); } catch { return false; } },
    // The hub's own work stops too (the heartbeat, so no nightly backup starts), then the queue.
    stopWork: async (ms) => { stopHub(); await stopWork(ms); },
    ...(o.reset?.tellMs ? { tellMs: o.reset.tellMs } : {}),
  });
  wireRepairs(keep.playbooks, { ledger, providers, models, connectors, role, spokes, devices });
  keep.watch(connectorWatch(keep.playbooks, connectors, o.resilience?.lookup));

  // Capture feeds event rules too, as the connector "capture" (topics: capture/routes.ts).
  const connectorCheck = triggers.connectorCheck;
  triggers.connectorCheck = (id, topic) => (id === 'capture' ? capture.topicCheck(topic) : connectorCheck ? connectorCheck(id, topic) : `There is no connector called ${id}.`);
  // A computer that says it can capture offers each kind as a source, off until the person says.
  spokes.on('change', (d: Device) => { try { capture.offer(d); } catch (e) { log.problem('capture', 'Nova couldn’t list what a computer can capture.', { detail: (e as Error)?.stack ?? String(e) }); } });
  // Every change to the privacy setting, or to the devices that count as local, is checked again
  // against what connectors keep open.
  profile.on('change', (c: { section: string }) => { if (c.section === 'privacy') connectors.recheck(); });
  devices.on('change', () => connectors.recheck());

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  connectors.on('change', (c) => bus.emit('event', 'connector', c));
  ledger.on('task', (t) => bus.emit('event', 'task', { id: t.id, title: t.title, state: t.state, reason: t.reason, user_visibility: t.user_visibility }));
  log.on('problem', (p) => bus.emit('event', 'problem', p));
  setup.on('change', (v) => bus.emit('event', 'setup', { step: v.step, done: v.done }));
  profile.on('change', (c) => bus.emit('event', 'profile', c));
  // Loosening the privacy setting releases work that was waiting on local capacity, if its worker
  // is now allowed under the stricter of the task's own mode and the new setting.
  profile.on('change', ({ section, key }) => {
    if (section !== 'privacy' || key !== 'default') return;
    for (const t of ledger.list({ state: 'waiting', limit: 500 })) {
      const w = ledger.workers.get(t.owner);
      if (!w || !t.reason?.includes('local capacity')) continue;
      if (permits(stricter(t.privacy_mode, profile.privacyDefault()), (() => { try { return egressOf(w, t.brief); } catch { return w.egress; } })())) ledger.retry(t.id, 'Your privacy setting changed, so this can run now.');
    }
  });
  extensions.on('change', (c) => bus.emit('event', 'extension', c));
  changes.on('change', (c) => bus.emit('event', 'change', c));
  providers.on('change', (c) => bus.emit('event', 'provider', c));
  // The UI swaps its design-system stylesheet when this arrives: no reload, no restart.
  design.on('change', (c) => bus.emit('event', 'design-system', c));
  triggers.on('trigger', (t) => bus.emit('event', 'trigger', { trigger_id: t.trigger_id, rule_id: t.rule_id, class: t.class, decision: t.triage.decision, reason: t.triage.reason, ledger_task_id: t.ledger_task_id, message_id: t.message_id }));
  triggers.on('message', (m) => bus.emit('event', 'message', m));
  devices.on('change', (c: { action: string; device: Device }) => bus.emit('event', 'device', { action: c.action, device: deviceView(c.device) }));
  spokes.on('change', (d: Device) => bus.emit('event', 'device', { action: 'heartbeat', device: deviceView(d) }));
  spokes.on('event', (e) => bus.emit('event', 'device_event', e));
  spokes.on('hardware', (d: Device, hw: unknown) => models!.heartbeat(d, hw));
  models.on('change', (c) => bus.emit('event', 'models', c));
  models.on('progress', (p) => bus.emit('event', 'model_progress', p));
  enroll.on('change', (r) => bus.emit('event', 'join_request', r));
  role.on('change', (s) => bus.emit('event', 'mesh', s));
  role.on('applied', (a) => bus.emit('event', 'sync', a));
  // Capture's rows come by sync too: a standby's pages reload it.
  role.on('applied', () => capture.synced());
  browser.on('change', (v) => bus.emit('event', 'browser', v));
  capture.on('change', (c) => bus.emit('event', 'capture', c));
  keep.playbooks.on('change', (c) => bus.emit('event', 'playbook', c));
  // A device that may no longer approve may no longer hold a browser either (browser/routes.ts).
  devices.on('revoked', (d: Device) => browser.release(`device:${d.id}`, `ended by Nova: its device was removed`));
  // Nor capture from it: its sources go off.
  devices.on('revoked', (d: Device) => capture.deviceRemoved(d.id));
  devices.on('revoked', (d: Device) => design.forgetDevice(d.id));
  devices.on('change', (c: { action: string; device: Device }) => {
    if (c.action === 'can_approve' && !c.device.can_approve) browser.release(`device:${c.device.id}`, 'ended by Nova: its device may no longer take over');
  });
  const stream = {
    on(listener: (event: string, data: unknown) => void) {
      const fn = (event: string, data: unknown) => listener(event, data);
      bus.on('event', fn);
      return () => bus.off('event', fn);
    },
  };

  // A device as the API shows it. Online: the hub always; others when heard from lately or holding
  // a stream open. `this`: the device asking (the hub, for the console).
  function deviceView(d: Device, p?: Principal) {
    const { public_key: _pk, x25519_public_key: _xk, ...rest } = d;
    const recent = d.last_seen ? now().getTime() - Date.parse(d.last_seen) < ONLINE_WINDOW_MS : false;
    const agent = d.kind === 'computer' && d.role !== 'hub' ? spokes.agent(d.id) : null;
    return {
      ...rest,
      ...(agent ? { agent } : {}),
      online: d.trust === 'trusted' && (d.role === 'hub' || access.isLive(d.id) || recent),
      this: p ? (p.kind === 'device' ? p.device.id === d.id : p.kind === 'console' && d.id === meshIdentity.id) : false,
    };
  }
  // The devices placement is resolved against (M10f): roles, hardware and health, as the hub knows
  // them now.
  async function placementDevices(): Promise<PlacementDevice[]> {
    const hubHw = models ? await models.hubHardware().catch(() => null) : null;
    return devices.list().map((d) => {
      const hw = d.id === meshIdentity.id ? hubHw : models?.hardwareOf(d.id) ?? null;
      return {
        id: d.id, name: d.name, kind: d.kind, role: d.role, platform: d.platform, purposes: d.purposes, trust: d.trust, last_seen: d.last_seen,
        hardware: hw ? { ram_bytes: hw.ram_bytes, gpus: hw.gpus.map((g) => ({ vram_bytes: g.vram_bytes, unified: g.unified })), disk: hw.disk ? { free_bytes: hw.disk.free_bytes } : null, platform: hw.platform, arch: hw.arch } : null,
        healthy: deviceView(d).online,
      };
    });
  }
  // A paired device's appearance id is remembered as its, so revoking it forgets its appearance.
  const ownedBy = (w: Who, appearanceId: unknown) => { if (w.principal.kind === 'device' && typeof appearanceId === 'string') design.own(appearanceId, w.principal.device.id); };
  const by = (w: Who) => (w.principal.kind === 'device' ? `device:${w.principal.device.id}` : w.principal.kind);
  // Joining and sessions happen only over the mesh listener, the transport §0 accepts.
  const meshOnly = (w: Who) => {
    if (w.listener !== 'mesh') throw new CoreError('forbidden', meshInfo ? `Devices join and sign in at ${meshInfo.publicUrl}, not at this address.` : 'Other devices can’t reach this Nova: it has no mesh address.');
  };
  // The computer asking, for routes only a device agent calls.
  const me = (w: Who): Device => {
    if (w.principal.kind !== 'device') throw new CoreError('forbidden', 'Only a paired computer’s device agent sends this.');
    return w.principal.device;
  };

  function health() {
    let database: { ok: boolean; detail: string };
    try {
      db.get('SELECT 1');
      database = { ok: true, detail: `Schema version ${db.version()}.` };
    } catch (e) {
      database = { ok: false, detail: `The database isn't answering: ${(e as Error).message}` };
    }
    const workers = [...ledger.workers.values()].map(info);
    const checks = {
      database,
      workers: { ok: workers.every((w) => w.health.ok), detail: workers.filter((w) => !w.health.ok).map((w) => w.health.detail).join(' ') || `${workers.length} ready.`, workers },
      ledger: { ok: true, counts: ledger.counts() },
      extensions: { ok: true, counts: extensions.counts() },
      design: { ok: true, active: design.active().id },
      triggers: { ok: true, counts: triggers.counts() },
      problems: { ok: true, open: log.problems({ open: true }).length },
      memory: { ok: true, counts: memory.counts() },
      receipts: { ok: true, counts: receipts.counts() },
      mesh: { ok: true, ...meshHealth() },
      vault: vaultHealth(),
      connectors: connectors.health(),
      browser: browserHealth(),
      capture: capture.health(),
      backups: keep.health(),
      changes: changes.health(),
      ingest: ingest.health(),
      computer: computer.health(),
    };
    return { ok: Object.values(checks).every((c) => c.ok), version: o.version, uptime_s: Math.round((Date.now() - started) / 1000), setup: { done: setup.view().done }, checks };
  }

  // Names only, never values; where the key lives, said plainly when it is a file.
  function vaultHealth() {
    const s = vault.status();
    return { ok: s.ok, detail: s.problem ?? (s.secrets ? `${s.secrets} secret${s.secrets === 1 ? '' : 's'}, key in ${s.where}.` : 'Empty.'), secrets: s.secrets, key: s.key, notice: s.notice };
  }

  // No Chromium is said plainly, but isn't a fault: browser work is simply unavailable. A browser
  // named in NOVA_CHROMIUM that isn't there is.
  function browserHealth() {
    const f = browser.chromium();
    return { ok: f.path !== null || f.from === 'none', available: f.path !== null, detail: f.detail, running: browser.list().length };
  }

  function meshHealth() {
    const s = role.status();
    return { role: s.role, epoch: s.epoch, listening: !!meshInfo, counts: devices.counts(), standby: s.standby, replica: s.replica };
  }

  // The one mesh setting: automatic failover, off unless the person sets a number of seconds. It
  // decides which machine becomes the hub, so it is the approvers' (like promotion) and tier 3.
  function meshSetting(key: string, value: unknown, confirm: boolean, who: Who) {
    if (allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', APPROVER_ONLY);
    if (key !== 'auto_failover_after_s') throw new CoreError('validation', 'The mesh section has one setting: auto_failover_after_s.');
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 86_400)) {
      throw new CoreError('validation', 'auto_failover_after_s is the number of seconds the hub must be unreachable before the standby takes over (1 to 86400), or null to leave it off.');
    }
    if (!confirm) throw new CoreError('validation', 'Changing automatic failover needs an explicit confirmation: send confirm: true.');
  }

  const header = (h: IncomingHttpHeaders, name: string) => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new CoreError('validation', `${what} is required.`);
    return v;
  };

  const routes: Route[] = [
    { method: 'GET', path: '/health', summary: 'Whether each part of the core is working, in plain words.', handle: () => health() },
    // The ingest gate (Amendment 2026-10-30-C Part 3).
    { method: 'GET', path: '/ingest/screens', summary: 'The latest screens of outside content: source, scores, flags and verdict, by hash; never the content. ?limit=', handle: ({ query }) => ingest.list(Number(query.get('limit')) || 50) },
    { method: 'GET', path: '/ingest/candidates', summary: 'Memory waiting for your OK: what a conversation that read outside content, or one of your devices, wanted kept, with where it came from.', handle: () => ingest.candidates() },
    { method: 'GET', path: '/ingest/screens/{id}', summary: 'One screen of outside content.', handle: ({ params }) => { const r = ingest.get(params.id!); if (!r) throw new CoreError('not_found', 'There is no such screen.'); return r; } },
    {
      method: 'POST', path: '/ingest/screen', summary: 'Screen outside content before a model reads it: the verdict (pass, quarantine or block), the scores and flags, and the extract a model may see.', body: '{text?, html?, headers?, attachments?, source: {kind, origin, ref?}}',
      handle: async ({ body }) => {
        const input = body as unknown as ScreenInput;
        if (typeof input.text !== 'string' && typeof input.html !== 'string') throw new CoreError('validation', 'Give the content as text or html.');
        const { id, verdict, scores, max, flags, extract, partial, model } = await ingest.screen(input);
        return { id, verdict, scores, max, flags, extract, partial, model };
      },
    },
    { method: 'GET', path: '/identity', summary: 'Who Nova is for this person: name, tuning, and the fixed charter.', handle: () => ({ identity: identityOf(profile), charter: CHARTER, rendered: render(identityOf(profile)) }) },
    { method: 'GET', path: '/profile', summary: 'The whole profile (no secrets; those are referenced by name only).', handle: () => profile.all() },
    {
      method: 'PUT', path: '/profile/{section}/{key}', summary: 'Change one profile record, as a settings screen would. The mesh section is tier 3 ({confirm: true}) and only an approver may change it.', body: '{value, confirm?}',
      handle: ({ params, body, who }) => {
        const section = params.section as Section;
        if (!SECTIONS.includes(section) || section === 'setup') throw new CoreError('validation', `There is no profile section called "${params.section}".`);
        if (section === 'mesh') meshSetting(params.key!, body.value, body.confirm === true, who);
        if (section === 'providers' || (section === 'policy' && params.key === 'task_tests')) throw new CoreError('validation', 'Providers are set through /api/v1/providers, so their settings are checked.');
        if (section === 'capture') throw new CoreError('validation', 'Capture settings are set through PUT /api/v1/capture/settings, so they are checked.');
        if (section === 'models') throw new CoreError('validation', 'Models are set through /api/v1/models, so their settings are checked.');
        if (section === 'backups') throw new CoreError('validation', 'Backups are set through PUT /api/v1/backups/settings, so the folders are checked.');
        if (section === 'appearance') {
          if (params.key !== 'mode') throw new CoreError('validation', 'Choose a design system with POST /api/v1/design-systems/{id}/apply, so it is checked and can be rolled back.');
          design.setMode(body.value);
          return profile.section(section);
        }
        profile.set(section, str(params.key, 'key'), body.value, 'settings');
        return profile.section(section);
      },
    },
    {
      // After a factory reset, until setup is done, the browser forgets what it kept of the Nova that
      // was erased (M7 amendment §2).
      method: 'GET', path: '/setup', summary: 'The setup conversation so far, and the question Nova is asking.',
      handle: async ({ who, headers }) => { await setup.ready(); const v = setup.view(); const h = reset.clearHeaders(who.principal, header(headers, 'cookie')); return Object.keys(h).length ? new Reply(v, h) : v; },
    },
    { method: 'POST', path: '/setup/messages', summary: 'Answer Nova in the setup conversation. Discovery and import, when asked for, run before the reply.', body: '{text}', handle: ({ body }) => setup.answer(str(body.text, 'text')) },
    {
      // Settings › Services, minimal (M10f): the backend in use and what it means on this OS. The map
      // and switching come later (M10i, M10k); there is nothing to switch to yet, and it says so.
      method: 'GET', path: '/services/backend', summary: 'How Nova runs its services on this computer: the backend in use (the supervisor), what it means on this OS, and where switching will be.',
      handle: () => ({ backend: 'supervisor', ...backendFor(deviceOs), switchable: false }),
    },
    {
      method: 'GET', path: '/tasks', summary: 'Work Ledger tasks, newest first. Filter with ?state=.',
      handle: ({ query }) => {
        const state = query.get('state');
        if (state && !STATES.includes(state as State)) throw new CoreError('validation', `state must be one of ${STATES.join(', ')}.`);
        const limit = Number(query.get('limit') ?? 50);
        if (!Number.isInteger(limit)) throw new CoreError('validation', 'limit must be a whole number.');
        return ledger.list({ ...(state ? { state: state as State } : {}), limit });
      },
    },
    {
      method: 'POST', path: '/tasks', status: 201, summary: 'Delegate a task. It must name a worker and the evidence that will prove it done.',
      body: '{title, owner, goal, evidence_required[], privacy_mode?, approval_tier?, inputs?, context_refs?, constraints?, idempotency_key?}',
      handle: ({ body }) => {
        const off = typeof body.owner === 'string' && !ledger.workers.has(body.owner) ? providers.explain(body.owner) : null;
        if (off) throw new CoreError('conflict', off);
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'user' } });
        triggers.reactive(task);
        return task;
      },
    },
    { method: 'GET', path: '/tasks/{id}', summary: 'One task, with its brief, report and verification.', handle: ({ params }) => ledger.get(params.id!) },
    { method: 'GET', path: '/tasks/{id}/events', summary: 'Everything that happened to a task, in order.', handle: ({ params }) => ledger.events(params.id!) },
    { method: 'POST', path: '/tasks/{id}/approve', summary: 'Give the OK a tier-2 or tier-3 task is waiting for. Tier 3 needs {confirm: true}.', body: '{confirm?}', handle: ({ params, body }) => ledger.approve(params.id!, { confirm: body.confirm === true }) },
    { method: 'POST', path: '/tasks/{id}/retry', summary: 'Try a blocked or partly done task again.', handle: ({ params }) => ledger.retry(params.id!) },
    { method: 'POST', path: '/tasks/{id}/cancel', summary: 'Stop a task. It ends cancelled, with the reason.', body: '{reason?}', handle: ({ params, body }) => ledger.cancel(params.id!, typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'Cancelled by you.') },
    { method: 'GET', path: '/workers', summary: 'Who can do delegated work, where their data goes, and whether they are healthy.', handle: () => [...ledger.workers.values()].map(info) },
    { method: 'GET', path: '/extensions', summary: 'Installed extensions and their state.', handle: () => extensions.list() },
    { method: 'POST', path: '/extensions', status: 201, summary: 'Install an extension from its manifest. It starts disabled; the reply lists what it asks for.', body: '{manifest}', handle: ({ body }) => extensions.install(body.manifest) },
    { method: 'POST', path: '/extensions/{id}/enable', summary: 'Enable an extension. Needs {approved: true} when it asks for permissions.', body: '{approved?}', handle: ({ params, body }) => extensions.enable(params.id!, { approved: body.approved === true }) },
    { method: 'POST', path: '/extensions/{id}/disable', summary: 'Disable an extension, keeping it installed.', handle: ({ params }) => extensions.disable(params.id!) },
    { method: 'DELETE', path: '/extensions/{id}', summary: 'Remove an extension, following its on_remove promise; nothing of it stays behind.', handle: ({ params }) => extensions.remove(params.id!) },
    { method: 'GET', path: '/design-systems', summary: 'Installed design systems, each with whether it is valid and, if not, its problems in plain words.', handle: () => design.list() },
    { method: 'GET', path: '/design-systems/schema', summary: 'The token schema every design system implements: names, CSS variables, value rules, contrast pairs, content rules.', handle: () => design.schema() },
    { method: 'GET', path: '/design-systems/active', summary: 'The design system this device shows (?device=), and whether that is its own choice, the person’s, or the default.', handle: ({ query }) => design.active(query.get('device')) },
    {
      method: 'POST', path: '/design-systems', status: 201, summary: 'Install a design system from its manifest, through the extension host. It is validated before it can be applied.', body: '{manifest}',
      handle: ({ body }) => design.install(body.manifest),
    },
    {
      method: 'POST', path: '/design-systems/rollback', summary: 'Go back to the design system shown before the last change, for the person or one device.', body: '{scope: user | device, device_id?}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.rollback({ scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/contrast-fix', summary: 'The live contrast check’s one-tap fix for one device: the colours of what it shows that fail (text under 4.5:1, outlines under 3:1) are nudged just far enough to pass, on that device only.', body: '{device_id}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.fixContrast({ device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/follow', summary: 'One device drops its own design system and shows the person’s again. Rolling back on that device brings its own back.', body: '{device_id}',
      handle: ({ body, who }) => { ownedBy(who, body.device_id); return design.follow({ device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    {
      method: 'POST', path: '/design-systems/contrast-fix/undo', summary: 'Take a device’s contrast fix away again.', body: '{device_id}',
      handle: ({ body }) => design.undoFix({ device_id: typeof body.device_id === 'string' ? body.device_id : null }),
    },
    { method: 'GET', path: '/design-systems/{id}', summary: 'One design system, with its manifest and validation.', handle: ({ params }) => design.get(params.id!) },
    { method: 'POST', path: '/design-systems/{id}/validate', summary: 'Check a design system against the schema: completeness, value syntax, contrast, reduced motion, content rules, extras.', handle: ({ params }) => design.validate(params.id!) },
    {
      method: 'GET', path: '/design-systems/{id}/preview.css', summary: 'A design system as CSS variables, for a sandboxed preview frame, without applying it. ?mode=light|dark|auto.',
      handle: ({ params, query }) => new Raw('text/css; charset=utf-8', design.previewCss(params.id!, query.get('mode'))),
    },
    {
      method: 'POST', path: '/design-systems/{id}/apply', summary: 'Apply a valid design system for the person (every device) or one device. The previous one is kept for rollback.', body: '{scope: user | device, device_id?}',
      handle: ({ params, body, who }) => { ownedBy(who, body.device_id); return design.apply(params.id!, { scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }); },
    },
    { method: 'GET', path: '/triggers/rules', summary: 'Every automation Nova runs: event, heartbeat and proactive rules. Nothing runs that isn’t listed here.', handle: () => triggers.listRules() },
    {
      method: 'POST', path: '/triggers/rules', status: 201, summary: 'Add a rule. For an event rule the reply carries its webhook token, shown this once only.',
      body: '{name, class: proactive|event|heartbeat, hook? or connector + topic? (event), cron? (heartbeat), action: {kind: task, task} | {kind: message, text}, dedup_window_s?, cooldown_s?}',
      handle: ({ body }) => {
        const { rule, token } = triggers.createRule(body as unknown as RuleInput, 'person');
        return token ? { rule, token, note: 'Keep this token somewhere safe. Nova keeps only a hash of it and won’t show it again.' } : { rule };
      },
    },
    { method: 'GET', path: '/triggers/rules/{id}', summary: 'One rule, with every change made to it.', handle: ({ params }) => ({ ...triggers.rule(params.id!), changes: triggers.ruleEvents(params.id!) }) },
    { method: 'PUT', path: '/triggers/rules/{id}', summary: 'Change a rule’s name, schedule, action, dedup window or cooldown.', body: '{name?, cron?, action?, dedup_window_s?, cooldown_s?}', handle: ({ params, body }) => triggers.updateRule(params.id!, body) },
    { method: 'POST', path: '/triggers/rules/{id}/pause', summary: 'Pause a rule. Its firings are recorded and dropped until it is resumed.', handle: ({ params }) => triggers.pause(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/resume', summary: 'Resume a paused rule. A schedule starts again from now.', handle: ({ params }) => triggers.resume(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/fire', summary: 'Run a proactive or heartbeat rule now.', body: '{payload?}', handle: ({ params, body }) => triggers.fireRule(params.id!, body.payload ?? {}) },
    { method: 'DELETE', path: '/triggers/rules/{id}', summary: 'Remove a rule. Its past firings stay in the record.', handle: ({ params }) => { triggers.deleteRule(params.id!); return { ok: true }; } },
    {
      method: 'GET', path: '/triggers', summary: 'Trigger records, newest first: what fired, how it was triaged and why, and what it led to. Filter with ?rule=.',
      handle: ({ query }) => triggers.list({ ...(query.get('rule') ? { rule: query.get('rule')! } : {}) }),
    },
    { method: 'GET', path: '/triggers/{id}', summary: 'One trigger record.', handle: ({ params }) => triggers.get(params.id!) },
    {
      // Public: an automation has no device session; the hook token is its key, checked below.
      method: 'POST', path: '/hooks/{name}', status: 202, auth: 'hook-token', access: 'public',
      summary: 'Call an event rule’s webhook. Authenticated by the x-nova-hook-token header instead of X-Nova, so automations can call it. The body is kept only as a hash; x-nova-dedup-key is optional.',
      body: 'any JSON object',
      handle: async ({ params, body, headers }) => {
        // A provider's callback (n8n) comes through the same token webhooks (M5a).
        const cb = await providers.hook(params.name!, header(headers, 'x-nova-hook-token'), body, headers);
        if (cb) return cb;
        const t = await triggers.hook(params.name!, header(headers, 'x-nova-hook-token'), body, header(headers, 'x-nova-dedup-key'));
        return { trigger_id: t.trigger_id, decision: t.triage.decision, reason: t.triage.reason };
      },
    },
    {
      method: 'GET', path: '/messages', summary: 'Messages Nova started, newest first. ?state=held for those waiting for quiet hours to end.',
      handle: ({ query }) => triggers.messages(query.get('state') === 'held' ? { state: 'held' } : {}),
    },
    { method: 'POST', path: '/messages/{id}/approve', summary: 'Send a message Nova held because it wasn’t sure; only you can release it.', handle: ({ params }) => triggers.approveMessage(params.id!) },
    { method: 'POST', path: '/messages/{id}/read', summary: 'Mark a message as read.', handle: ({ params }) => triggers.read(params.id!) },
    { method: 'GET', path: '/problems', summary: 'Things that went wrong and matter to the person. ?open=1 for unresolved only.', handle: ({ query }) => log.problems({ open: query.get('open') === '1' }) },
    { method: 'POST', path: '/problems/{id}/resolve', summary: 'Mark a problem as dealt with.', handle: ({ params }) => { log.resolve(Number(params.id)); return { ok: true }; } },
    {
      method: 'GET', path: '/memory', summary: 'Everything Nova remembers, newest first, corrected and expired records included and marked. Filter with ?kind=&scope=&state=.',
      handle: ({ query }) => memory.list({
        ...(query.get('kind') ? { kind: query.get('kind') as MemoryKind } : {}),
        ...(query.get('scope') ? { scope: query.get('scope')! } : {}),
        ...(query.get('state') ? { state: query.get('state') as UserState } : {}),
      }),
    },
    {
      method: 'POST', path: '/memory', status: 201, summary: `Remember something, as the person. kind is one of ${MEMORY_KINDS.join(', ')}.`,
      body: '{kind, content, source?, observed_at?, confidence?, scope?, expires?}',
      handle: ({ body }) => memory.remember({ ...(body as unknown as MemoryInput), recorded_by: 'person' }),
    },
    { method: 'GET', path: '/memory/search', summary: 'Find active memories that share words with ?q=, with the list of what was retrieved. Also ?scope=&limit=.', handle: ({ query }) => memory.search(str(query.get('q'), 'q'), { ...(query.get('scope') ? { scope: query.get('scope')! } : {}), ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}) }) },
    { method: 'POST', path: '/memory/export', summary: 'Write the active memories as plain files (memory.json and memory.md) and return where they are.', handle: () => memory.export() },
    { method: 'POST', path: '/memory/{id}/correct', summary: 'Correct a memory. The correction supersedes it; the old record is kept, marked corrected.', body: '{content}', handle: ({ params, body }) => memory.correct(params.id!, str(body.content, 'content'), 'person') },
    { method: 'POST', path: '/memory/{id}/confirm', summary: 'Confirm a memory is right.', handle: ({ params }) => memory.confirm(params.id!, 'person') },
    { method: 'DELETE', path: '/memory/{id}', summary: 'Forget a memory for real: it and every correction of it are deleted, leaving only a note that something was forgotten.', handle: ({ params }) => memory.forget(params.id!, 'person') },
    {
      method: 'GET', path: '/receipts', summary: 'What each model call was told and where it went, newest first. ?egress=remote is the egress log; also ?task_id=&session_id=.',
      handle: ({ query }) => receipts.list({
        ...(query.get('task_id') ? { task_id: query.get('task_id')! } : {}),
        ...(query.get('session_id') ? { session_id: query.get('session_id')! } : {}),
        ...(query.get('egress') ? { egress: query.get('egress') as 'local' | 'remote' } : {}),
      }),
    },
    {
      // Tier 0: drafting. Where a definition would run, and why each device may or may not take it.
      method: 'POST', path: '/services/placement', summary: 'Where a service definition would run, resolved against every device’s roles, hardware and health: the device or devices, and each device’s reason. Nothing is deployed (tier 0).', body: '{definition}',
      handle: async ({ body }) => {
        const devs = await placementDevices();
        const v = validate(body.definition, { devices: devs.filter((d) => d.trust === 'trusted').map((d) => ({ id: d.id, platform: d.platform, roles: [...d.purposes] })) });
        if (!v.ok) return { valid: false, problems: v.problems, resolution: null };
        const resolution = resolvePlacement(v.def, devs, { hubId: meshIdentity.id, now: now() });
        const away = resolution.ok ? resolution.devices.filter((d) => d.id !== meshIdentity.id) : [];
        return { valid: true, problems: [], resolution, ...(away.length ? { note: 'Running services on devices other than the hub comes with native workloads; nothing is deployed there yet.' } : {}) };
      },
    },
    // ---- the device mesh (M4 plan §0–§1) ----
    {
      method: 'GET', path: '/mesh/hello', access: 'public', summary: 'The hub’s fingerprint, epoch, role and public keys. No person data; anyone may ask.',
      handle: () => {
        const s = devices.state();
        const self = devices.find(meshIdentity.id);
        // The hub's signed roster too, so a hub that was away can tell it was replaced (fencing).
        return {
          name: self?.name ?? 'Nova', id: meshIdentity.id, fingerprint: meshIdentity.fingerprint, epoch: s.epoch, role: s.role, public_key: meshIdentity.publicKey, x25519_public_key: meshIdentity.x25519PublicKey,
          ...(s.role === 'hub' ? { roster: devices.roster() } : {}),
        };
      },
    },
    {
      method: 'GET', path: '/mesh/status', access: 'mesh', summary: 'Whether other devices can reach this Nova, where, and who is asking.',
      handle: ({ who }) => {
        const p = who.principal;
        return {
          public_url: publicUrl(), transport: meshInfo?.transport ?? null, fingerprint: meshIdentity.fingerprint, ...meshHealth(),
          you: p.kind === 'device' ? { console: false, device_id: p.device.id, kind: p.device.kind, can_approve: p.device.can_approve } : { console: true, device_id: meshIdentity.id, kind: 'computer', can_approve: true },
        };
      },
    },
    { method: 'GET', path: '/mesh/devices', summary: 'The device registry, the hub first. The device asking is marked `this`.', handle: ({ who }) => devices.list().map((d) => deviceView(d, who.principal)) },
    {
      method: 'PATCH', path: '/mesh/devices/{id}', summary: 'Rename a device, let it approve new devices (tier 3: needs {confirm: true}, and only an approver may grant it), or change its roles (purposes: widening is tier 3, {confirm: true}; narrowing is tier 2, {approved: true}; making a computer a hub candidate also needs {confirm_candidate: true}).', body: '{name?, can_approve?, purposes?, confirm?, approved?, confirm_candidate?}',
      handle: ({ params, body, who }) => {
        if ((body.can_approve !== undefined || body.purposes !== undefined) && allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', 'Only the hub’s own screen, or a device you’ve allowed to approve, can change who approves or what a device is for.');
        if (body.name !== undefined) devices.rename(params.id!, body.name);
        if (body.can_approve !== undefined) devices.setCanApprove(params.id!, body.can_approve, body.confirm === true);
        // Nothing runs on other devices before native workloads (M10h), so narrowing stops nothing.
        if (body.purposes !== undefined) devices.setPurposes(params.id!, body.purposes, { confirm: body.confirm === true, approved: body.approved === true, confirm_candidate: body.confirm_candidate === true, by: by(who), stops: () => [] });
        return deviceView(devices.get(params.id!), who.principal);
      },
    },
    {
      method: 'POST', path: '/mesh/devices/{id}/revoke', summary: 'Revoke a device (tier 3: needs {confirm: true}). Its sessions end and its open streams close at once; its key can never sign in or enroll again.', body: '{confirm, reason?}',
      handle: ({ params, body, who }) => deviceView(devices.revoke(params.id!, { confirm: body.confirm === true, reason: body.reason, by: by(who) }), who.principal),
    },
    { method: 'POST', path: '/mesh/pairings', status: 201, access: 'approver', summary: 'Make a pairing code: single use, five minutes. The reply has the QR address, the one-line command and the hub’s fingerprint.', handle: ({ who }) => enroll.createPairing(by(who)) },
    { method: 'GET', path: '/mesh/requests', access: 'approver', summary: 'Devices waiting for your OK, each with the six digits it shows.', handle: () => enroll.requests() },
    {
      method: 'POST', path: '/mesh/requests/{id}/approve', access: 'approver', summary: 'Approve a device (tier 3: needs {confirm: true}) once its digits match, with the roles you settled on (purposes; default: what it asked for). A computer as hub candidate also needs {confirm_candidate: true}. This creates its device record.', body: '{confirm, purposes?, confirm_candidate?}',
      handle: ({ params, body, who }) => { const r = enroll.approve(params.id!, { confirm: body.confirm === true, by: by(who), ...(body.purposes !== undefined ? { purposes: body.purposes } : {}), confirm_candidate: body.confirm_candidate === true }); return { request: r.request, device: deviceView(r.device, who.principal) }; },
    },
    { method: 'POST', path: '/mesh/requests/{id}/deny', access: 'approver', summary: 'Turn a device away.', handle: ({ params, who }) => enroll.deny(params.id!, by(who)) },
    {
      method: 'POST', path: '/mesh/join', status: 201, access: 'public', summary: 'A device asks to join with a code, its public keys, and a commitment to its nonce. A wrong or spent code is a 400 with no detail.',
      body: '{code, public_key, x25519_public_key, x25519_sig, claims: {name, platform, kind, capabilities[], purposes?[], address?}, commitment}',
      handle: ({ body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.join(body, who.address); },
    },
    {
      method: 'POST', path: '/mesh/join/{id}/reveal', access: 'public', summary: 'The device reveals its nonce, signed over nova-add-device-reveal-v1.<id>.<time>; the reply is the six digits.', body: '{device_nonce, time, signature}',
      handle: ({ params, body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.reveal(params.id!, body); },
    },
    {
      method: 'GET', path: '/mesh/join/{id}', access: 'public', summary: 'The device polls its request: ?time=&signature= over nova-add-device-status-v1.<id>.<time>. Approved, it gets its device id and the signed roster.',
      handle: ({ params, query, who }) => { meshOnly(who); enroll.limit('polls', who.address); return enroll.status(params.id!, { time: query.get('time'), signature: query.get('signature') }); },
    },
    {
      method: 'POST', path: '/mesh/session', access: 'public', summary: 'A trusted device starts a 12-hour session, signed over nova-session-v1.<device_id>.<time>. {cookie: true} sets an HttpOnly cookie instead of returning a token.',
      body: '{device_id, time, signature, cookie?}',
      handle: ({ body, who }) => {
        meshOnly(who);
        enroll.limit('calls', who.address);
        const s = devices.startSession(body);
        const out = { device_id: s.device.id, kind: s.device.kind, expires_at: s.expires_at };
        if (body.cookie !== true) return { ...out, token: s.token };
        return new Reply(out, { 'set-cookie': sessionCookie(s.token, { secure: publicUrl()?.startsWith('https:') ?? false, maxAgeS: SESSION_TTL_MS / 1000 }) });
      },
    },
    { method: 'GET', path: '/mesh/roster', access: 'mesh', summary: 'Who the hub and the standby are, signed by this node: devices pin both keys from it.', handle: () => devices.roster() },
    // ---- computers' device agents (M4 plan §2) ----
    {
      method: 'GET', path: '/mesh/hello/proof', access: 'public', summary: 'This node signs a device’s ?challenge= over nova-hello-v1.<challenge>.<{id, role, epoch, public_key}>, so a device agent knows it holds a pinned key before signing in.',
      handle: ({ query, who }) => { enroll.limit('polls', who.address); return spokes.proof(query.get('challenge')); },
    },
    {
      method: 'POST', path: '/mesh/devices/me/heartbeat', access: 'device', summary: 'A device agent is alive: last seen now, with its capabilities, versions and whether it is in safe mode. The reply names the runtime this node ships.',
      body: '{capabilities?, version?, runtime_version?, safe_mode?}',
      handle: ({ body, who }) => spokes.heartbeat(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/devices/me/report', access: 'device', summary: 'A device agent reports a problem the person should know about (a runtime update it refused).', body: '{problem: runtime_update_refused | runtime_install_failed, detail?}',
      handle: ({ body, who }) => spokes.report(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/inbox', access: 'device', summary: 'A device agent’s queued items, in order, each taken in exactly once by its key: events, task requests (a task, or a refusal kept with its reason), memory notes (recorded_by device:<id>), config changes (server wins: a stale base_version is rejected).',
      body: '{items: [{key, kind: event | task_request | memory_note | config_change, body, created_at?}]}',
      handle: ({ body, who }) => spokes.inbox(me(who), body),
    },
    { method: 'GET', path: '/mesh/inbox/refusals', summary: 'What devices sent that was refused or rejected, with the reasons, newest first. ?device= for one.', handle: ({ query }) => spokes.refusals(query.get('device') ?? undefined) },
    {
      method: 'GET', path: '/mesh/config/{section}/{key}', access: 'device', summary: `A setting a device agent may change (${DEVICE_CONFIG_SECTIONS.join(', ')}), with its version, which a change must name as base_version.`,
      handle: ({ params }) => {
        // What a computer may read is what it may change, and no more: the setup conversation,
        // privacy and appearance stay with the person (the approval sheet promises so).
        if (!(DEVICE_CONFIG_SECTIONS as readonly string[]).includes(params.section!) || !DEVICE_CONFIG_KEY.test(params.key!)) {
          throw new CoreError('forbidden', `A device can read ${DEVICE_CONFIG_SECTIONS.join(', ')} settings only, by section and key.`);
        }
        const r = configRow(params.section!, params.key!);
        return { section: params.section, key: params.key, value: r ? JSON.parse(r.value) : null, version: r ? configVersion(r) : null };
      },
    },
    { method: 'GET', path: '/mesh/runtime', access: 'device', summary: 'The runtime agent this node ships, {manifest: {version, sha256, files}, signature, signer, files}, signed over nova-runtime-v1.<manifest>.', handle: () => spokes.runtime() },
    ...role.routes(),
    // ---- the vault and connectors (M5 plan §2) ----
    { method: 'GET', path: '/vault', summary: 'The vault: how many secrets, their names (never their values), and where its key is, said plainly when it is a file.', handle: () => ({ ...vault.status(), names: vault.status().ok ? vault.list() : [] }) },
    {
      method: 'PUT', path: '/vault/{name}', summary: 'Keep a provider’s secret (an API key, a signing secret) in the vault under the name its settings use as secret://NAME. The value is never shown again.', body: '{value}',
      handle: ({ params, body }) => {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(params.name!)) throw new CoreError('validation', 'A secret’s name is capital letters, digits and underscores, like API_KEY.');
        if (typeof body.value !== 'string' || !body.value.trim()) throw new CoreError('validation', 'value is the secret itself, and it can’t be empty.');
        try {
          vault.put(`provider/${params.name}`, body.value.trim());
        } catch (e) {
          // A full disk is the person's to know about beyond this one refusal (M7b): a problem
          // with its playbook.
          if (e instanceof CoreError && e.details.some((d) => d.startsWith('ENOSPC'))) log.problem('vault', 'Nova couldn’t save a secret because the disk is full. Nothing in the vault changed.', { detail: e.details.join('\n') });
          throw e;
        }
        return { name: params.name, ref: `secret://${params.name}`, stored: true };
      },
    },
    {
      method: 'POST', path: '/vault/reset', summary: 'Start a new, empty vault (tier 3: needs {confirm: true}), for one that can’t be opened: the old file is kept aside in vault/ as secrets.json.unopenable-<time>. Every connection and key must be set again.', body: '{confirm}',
      handle: ({ body }) => vault.reset(body.confirm === true),
    },
    {
      method: 'DELETE', path: '/vault/{name}', summary: 'Delete a provider’s secret from the vault.',
      handle: ({ params }) => {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(params.name!)) throw new CoreError('validation', 'A secret’s name is capital letters, digits and underscores, like API_KEY.');
        return { name: params.name, deleted: vault.delete(`provider/${params.name}`) };
      },
    },
    { method: 'GET', path: '/connectors', summary: 'Connections to outside services: status, what each can do in plain words, where its calls go, and the one Nova recommends connecting next.', handle: () => ({ connectors: connectors.list(), vault: vaultHealth() }) },
    { method: 'GET', path: '/connectors/{id}', summary: 'One connection.', handle: ({ params }) => connectors.view(params.id!) },
    { method: 'POST', path: '/connectors/{id}/connect', summary: 'Connect a service with what its setup asks for (an address, a token). Secrets go into the vault.', body: '{…setup fields}', handle: ({ params, body }) => connectors.connect(params.id!, body) },
    { method: 'POST', path: '/connectors/{id}/disconnect', summary: 'Disconnect: sign Nova out at the service where it can, then delete its secrets, the rules listening to it and its settings.', handle: ({ params }) => connectors.disconnect(params.id!) },
    ...connectors.routes(),
    ...providers.routes(),
    // ---- capture (M6 plan §1) ----
    ...captureRoutes(capture),
    ...models.routes(),
    // ---- resilience (M7 plan §2–§3): backups, the drill, playbooks, the supervisor ----
    ...keep.routes((w) => { if (w.principal.kind !== 'console') throw new CoreError('forbidden', 'Releases are deployed and rolled back from the hub’s own screen only.'); }),
    // ---- checkpoints (M7 amendment §1) ----
    ...checkpoints.routes(),
    // ---- factory reset (M7 amendment §2) ----
    ...reset.routes(),
    // ---- the change pipeline and the foundry (M7 plan §1) ----
    ...changes.routes(),
    {
      method: 'POST', path: '/foundry', status: 201, summary: 'Ask the foundry for an extension: it writes it with its tests and probe (the local model by default) and proposes it as a change, tier 3.',
      body: '{need, kind: trigger-rules | template | skill-pack | design-system, via?: local-model | chat}',
      handle: ({ body }) => foundry.request(body),
    },
    // ---- Nova Computer (M10a) ----
    ...computerRoutes(computer),
    // ---- coding through chat (M10c) ----
    ...codingRoutes(coding),
    // ---- infrastructure through chat (M10d) ----
    ...infraRoutes(infra),
    // ---- networking through chat (M10d) ----
    ...networkRoutes(network),
    // ---- browser work with takeover (M5 plan §3) ----
    ...browserRoutes(browser, {
      home: o.home,
      holder: (w) => (w.principal.kind === 'device' ? { key: `device:${w.principal.device.id}`, label: w.principal.device.name } : { key: 'console', label: 'The hub’s own screen' }),
      // Stop (M10b): the task is cancelled; its browser closes with it.
      stop: (id, why) => {
        const t = ledger.get(id);
        if (t.owner !== browser.worker.id) throw new CoreError('validation', 'That isn’t a browser task.');
        return ledger.cancel(id, why);
      },
    }),
  ];

  // Tests drive the heartbeat's clock through the API; this route doesn't exist otherwise.
  if (process.env.NOVA_TEST_CLOCK === '1') {
    routes.push({
      method: 'POST', path: '/triggers/tick', summary: 'Test only: run the heartbeat as if it were the given time.', body: '{now?}',
      handle: ({ body }) => {
        const at = body.now === undefined ? now() : new Date(String(body.now));
        if (Number.isNaN(at.getTime())) throw new CoreError('validation', 'now must be an ISO time.');
        return triggers.tick(at);
      },
    });
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<unknown> = Promise.resolve();
  const beat = () => {
    try { enroll.sweep(); } catch (e) { log.problem('mesh', 'Nova couldn’t tidy up old requests to join.', { detail: (e as Error)?.stack ?? String(e) }); }
    ticking = triggers.tick().catch((e) => log.problem('triggers', 'The heartbeat couldn’t check the schedules.', { detail: (e as Error)?.stack ?? String(e) }));
    // The clock watch, and Nova's own retries of repairs that haven't worked yet.
    void keep.sweep().catch((e) => log.warn('resilience', 'The repair sweep stumbled.', { error: (e as Error).message }));
    // Every infrastructure project against its budget (M10d).
    try { infra.sweep(); } catch (e) { log.warn('infra', 'The budget sweep stumbled.', { error: (e as Error).message }); }
    // The dead-man's switch, on the clock as well as its timers (M10d).
    try { network.sweep(); } catch (e) { log.warn('network', 'The dead-man’s switch sweep stumbled.', { error: (e as Error).message }); }
  };
  // The hub's own work: the ledger, recovered, and the heartbeat. A standby runs neither.
  function startHub() {
    const recovered = ledger.recover();
    providers.recover();
    coding.recover();
    infra.recover();
    network.recover();
    // A sandbox copy reaches nothing outside itself and keeps no clock of its own: the pipeline
    // drives it.
    if (o.sandbox) return recovered;
    models!.start();
    if (!heartbeat) {
      heartbeat = setInterval(beat, 30_000);
      heartbeat.unref();
      beat();
    }
    connectors.start();
    capture.start();
    changes.start();
    return recovered;
  }
  function stopHub() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    changes.stop();
    network.close();
    models!.stop();
    providers.stop();
    connectors.stop().catch(() => {});
    capture.stop().catch(() => {});
  }
  // On a standby (or a hub that stepped down) every change is refused, saying which node is hub;
  // the only change it takes is becoming the hub.
  const REPLICA_WRITES = new Set(['/api/v1/mesh/promote']);

  // GET /join.sh and GET /device-agent.tar: the one-line command's script, and the agent it unpacks.
  let tarCache: Buffer | null = null;
  function agentDownload(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if ((url.pathname !== '/join.sh' && url.pathname !== '/device-agent.tar') || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const sh = url.pathname === '/join.sh';
    tarCache ??= agentTar(o.version);
    // The script names the archive's hash, and checks what it downloads against it.
    const body = sh ? Buffer.from(joinScript(publicUrl(), createHash('sha256').update(tarCache).digest('hex'))) : tarCache;
    res.writeHead(200, {
      'content-type': sh ? 'text/x-shellscript; charset=utf-8' : 'application/x-tar', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(sh ? {} : { 'content-disposition': 'attachment; filename="device-agent.tar"' }),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const api = createApi({
    routes, stream, version: o.version, trustedOrigin: o.trustedOrigin,
    // The approval prompt goes only where it can be answered.
    visible: (event, p) => event !== 'join_request' || allows('approver', p) === 'ok',
    onError: (e) => log.problem('api', 'Something went wrong inside Nova while answering a request.', { detail: (e as Error)?.stack ?? String(e) }),
  });

  // Grounding (self.ts): the briefing and the agent's read-only status tools, in process.
  const self = new Self({
    home: o.home, ingest, version: o.version, instance: () => o.instance ?? 'production', codeRoot: CODE_ROOT,
    profile, memory, providers, models: models!, connectors, capture, devices, triggers, design, log, now,
    hubId: () => meshIdentity.id, role: () => role.role(), online: (d) => deviceView(d).online, setupDone: () => setup.view().done,
    ...(o.chat ? { chat: o.chat } : {}),
  });

  return {
    self,
    db, log, profile, ledger, setup, extensions, design, workspace, migration, routes, templates, decisions, triggers, memory, receipts, backups, providers, browser, computer, coding, infra, network,
    ingest, vault, connectors, capture, models, changes, foundry, resilience: keep, checkpoints, restarter, reset,
    // Restarts this Nova in place (resilience/restart.ts): what a restore, or a factory reset, calls
    // once its marker is staged.
    restartInPlace: (why: string) => restarter.restartInPlace(why),
    // Before a restart in place (and a stop): running tasks stop and are left for the next start,
    // and every process Nova started is ended, within `boundMs`.
    stopWork,
    health,
    openapi: api.doc,
    identity: () => identityOf(profile),
    persona: () => render(identityOf(profile)),
    mesh: { identity: meshIdentity, devices, enroll, access, spokes, info: meshInfo, role, sync },
    // Who is asking, for a request outside /api/v1, or null once a refusal was sent (mesh/access.ts).
    gate: (req: IncomingMessage, res: ServerResponse, url: URL, listener: Listener) => {
      const p = access.gate(req, res, url, listener);
      // While a factory reset is staged, nothing new is taken.
      const resetting = p ? reset.blocks(req.method, url.pathname) : null;
      if (resetting) {
        res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: resetting, resetting: true }));
        return null;
      }
      const replica = p && req.method !== 'GET' && req.method !== 'HEAD' && !REPLICA_WRITES.has(url.pathname) ? role.replica() : null;
      if (!replica) return p;
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: replica.reason, replica: true }));
      return null;
    },
    // The core's routes, for the principal the gate found.
    // Also the device agent's installer and archive (public; mesh/access.ts PUBLIC_PATHS).
    handle: async (req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal, listener: Listener) => {
      const address = access.address(req, listener);
      // Contact for the dead-man's switch (M10d): a trusted device's request on the mesh listener,
      // once its answer went out successfully, and only from off the hub's own machine.
      if (principal.kind === 'device' && listener === 'mesh') {
        const id = principal.device.id;
        res.once('finish', () => {
          if (res.statusCode >= 400) return;
          const bare = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
          const onHub = loopbackAddress(bare) || hubAddress().hosts.some((h) => h.replace(/^\[|\]$/g, '') === bare);
          try { network.contact(id, { onHub }); } catch (e) { log.warn('network', 'Nova couldn’t record contact with a device.', { error: (e as Error).message }); }
        });
      }
      return agentDownload(req, res, url) || api.handle(req, res, url, { principal, listener, address });
    },
    // A hub recovers the ledger, then starts the heartbeat: once now (to catch up), then every
    // 30 s. A standby starts copying the hub instead, and runs nothing else.
    start() {
      // Under the supervisor: where the data stands before any work runs (recovery, the
      // heartbeat), so going back to an older release can tell whether it would undo any of it.
      o.supervisor?.mark?.({
        seq: db.get<{ s: number }>('SELECT IFNULL(MAX(seq), 0) AS s FROM sync_log')?.s ?? 0,
        problem: db.get<{ p: number }>('SELECT IFNULL(MAX(id), 0) AS p FROM problem')?.p ?? 0,
      });
      // A clock that went back while Nova was off shows as records written "in the future". A
      // sandbox copy (M7a's sandbox mode, also used by the restore drill and release deploys)
      // keeps no clock of its own.
      if (!o.sandbox) keep.checkClock(true);
      browser.sweep();
      // A restore finished at this start becomes a ledger task with its evidence.
      if (role.role() === 'hub' && !o.sandbox) {
        try { checkpoints.recordFinished(); } catch (e) { log.problem('resilience', 'Nova couldn’t record a finished restore in the ledger.', { detail: (e as Error)?.stack ?? String(e) }); }
      }
      const recovered = role.role() === 'hub' ? startHub() : { requeued: [], reverified: [] };
      role.start();
      return recovered;
    },
    // Waits briefly for running work; anything still running is requeued on the next start.
    async close() {
      stopHub();
      await role.close();
      // Browsers close first and their tasks stay as they are: the next start runs them again.
      await browser.close();
      computer.close();
      coding.close();
      network.close();
      await capture.stop();
      await Promise.race([ticking.then(() => ledger.idle()), new Promise((r) => setTimeout(r, 2000).unref())]);
      db.close();
    },
  };
}

// Replaces the hub's keys after they were exposed (the README's “If the hub’s keys were exposed”):
// new keys under the same id, a higher epoch, and the computers and standby that pinned the old key
// revoked, to be added again. Run with Nova stopped (scripts/rotate-hub-keys.js).
export async function rotateHubKeys(home: string, o: { now?: () => Date } = {}) {
  // A mistyped home must not become a new, empty one.
  if (!existsSync(join(home, 'mesh', 'identity.json'))) throw new CoreError('not_found', `${home} has no keys to replace (no mesh/identity.json). Is that Nova’s home?`);
  const open =() => createCore({ home, version: 'rotate', trustedOrigin: () => false, ...(o.now ? { now: o.now } : {}) });
  const probe = open();
  const hub = probe.mesh.role.role() === 'hub';
  await probe.close();
  if (!hub) throw new CoreError('conflict', 'This node is a standby, not the hub. Enroll it again with a new home instead of replacing its keys.');
  replaceIdentityKeys(home, o);
  const core = open();
  try {
    const r = core.mesh.devices.rekeyHub('console');
    return { epoch: r.epoch, fingerprint: core.mesh.identity.fingerprint, revoked: r.revoked.map((d) => ({ id: d.id, name: d.name, kind: d.kind })) };
  } finally {
    await core.close();
  }
}
