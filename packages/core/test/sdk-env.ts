// Shared fixtures for the extension SDK tests (FR-117): the sample extension from @nova/sdk,
// folders written on the fly, packing with or without a publisher key, and a service wired to a
// real plugin installer, hook store and policy gate over an in-memory database.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS,
  type SettingKey,
  type ToolDescriptor,
  type TrustedPublisher,
} from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ExtensionService,
  HookService,
  MemoryEventSink,
  PluginCatalogs,
  PluginService,
  PolicyGate,
  PolicyStore,
  folderBundleFiles,
  loadPublisherPrivateKey,
  packBundle,
  type AuditRecord,
  type ExtensionServiceOptions,
  type GateRequest,
  type NotificationInput,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';
export const THREAD = '01920000-0000-7000-8000-0000000000a1';
export const HELLO_DIR = fileURLToPath(new URL('../../sdk/examples/hello/', import.meta.url));
export const HELLO_ID = 'com.example.hello';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A copy of the sample extension a test may edit. */
export function copyHello(dir: string, name = 'hello'): string {
  const root = join(dir, 'src', name);
  cpSync(HELLO_DIR, root, { recursive: true });
  return root;
}

/** Write files (relative path → text or JSON value) under `root`. */
export function writeTree(root: string, files: Record<string, unknown>): string {
  for (const [rel, value] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

/** A small extension with one command per probe, for permission tests. */
export function probeExtension(
  dir: string,
  opts: { id?: string; code: string; permissions?: Record<string, unknown>; version?: string },
): string {
  const id = opts.id ?? 'com.example.probe';
  const root = join(dir, 'src', id);
  rmSync(root, { recursive: true, force: true });
  return writeTree(root, {
    '.nova-plugin/plugin.json': {
      schemaVersion: 1,
      id,
      name: 'Probe',
      version: opts.version ?? '1.0.0',
      permissions: { actionDefaults: { read: 'allow', write: 'ask' } },
    },
    '.nova-plugin/extension.json': {
      api: 1,
      entry: 'main.js',
      permissions: opts.permissions ?? {},
    },
    'main.js': opts.code,
  });
}

/** A `.novax` of a folder, signed when a PEM private key is given. */
export function packFolder(root: string, privateKeyPem?: string): Uint8Array {
  return packBundle(folderBundleFiles(root), {
    privateKey: privateKeyPem ? loadPublisherPrivateKey(privateKeyPem) : null,
  }).bytes;
}

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

let calls = 0;
/** A model's call of a tool in the test thread, for the gate. */
export function gateRequest(tool: ToolDescriptor, args: unknown): GateRequest {
  calls++;
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${calls}`,
    projectId: null,
    mode: 'chat',
    tool,
    args,
    argsPreview: JSON.stringify(args),
    // The user asked for it in this turn (FR-189), so the extension's own defaults decide.
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
  };
}

export interface SdkEnv {
  dir: string;
  db: NovaDatabase;
  secrets: MemorySecretStore;
  events: MemoryEventSink;
  audit: AuditRecord[];
  notices: NotificationInput[];
  plugins: PluginService;
  hooks: HookService;
  gate: PolicyGate;
  service: ExtensionService;
  settings: { enabled: boolean; trusted: TrustedPublisher[] };
  close(): Promise<void>;
}

export async function makeSdkEnv(over: Partial<ExtensionServiceOptions> = {}): Promise<SdkEnv> {
  const dir = tempDir('nova-sdk-');
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'workspace'), { recursive: true });
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'idle', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  const secrets = new MemorySecretStore();
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const notices: NotificationInput[] = [];
  const auditSink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  const plugins = new PluginService({
    db,
    secrets,
    dataDir,
    catalogs: new PluginCatalogs({ cacheDir: join(dir, 'cache') }),
    catalogConfigs: () => Promise.resolve([]),
    events,
    audit: auditSink,
  });
  const gate = new PolicyGate({
    store: new PolicyStore({ db }),
    events,
    audit: auditSink,
    notifier: { notify: () => Promise.resolve() },
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    dataDir,
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
  });
  const hooks = new HookService({
    db,
    events,
    audit: auditSink,
    userFile: join(dataDir, 'hooks.json'),
    gate,
  });
  hooks.usePluginHooks(plugins.hooks);
  const settings = { enabled: true, trusted: [] as TrustedPublisher[] };
  const service = new ExtensionService({
    db,
    secrets,
    dataDir,
    plugins,
    settings: {
      enabled: () => Promise.resolve(settings.enabled),
      trustedPublishers: () => Promise.resolve(settings.trusted),
    },
    events,
    audit: auditSink,
    notifier: { notify: (n) => (notices.push(n), Promise.resolve()) },
    hookStore: hooks.store,
    host: { startTimeoutMs: 15_000, invokeTimeoutMs: 10_000, restartDelayMs: 50 },
    ...over,
  });
  gate.usePluginPermissions(service.permissionSource(plugins));
  hooks.useMcp(service.hookClient(null));
  hooks.useGate(service.hookGate(gate));
  return {
    dir,
    db,
    secrets,
    events,
    audit,
    notices,
    plugins,
    hooks,
    gate,
    service,
    settings,
    close: async () => {
      await service.close();
      hooks.close();
      await gate.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
