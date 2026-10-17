import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type MockProviderOptions } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ArtifactService,
  ChatService,
  DirectRouter,
  MemoryEventSink,
  MemoryService,
  ProjectService,
  ProviderRegistry,
  SourceService,
  ThreadService,
  ToolRegistry,
  ToolRuntime,
  UnavailableSandbox,
  allowAllGate,
  builtinSource,
  builtinTools,
  type AuditRecord,
  type ChatServiceOptions,
  type DeferBudget,
  type ModelRouter,
  type ProviderFactory,
  type SandboxClient,
  type ToolGate,
  type ToolRoot,
  type ToolScope,
  type ToolSourceProvider,
  type WebToolOptions,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';

export interface Env {
  db: NovaDatabase;
  dir: string;
  secrets: MemorySecretStore;
  registry: ProviderRegistry;
  router: ModelRouter;
  threads: ThreadService;
  chat: ChatService;
  events: MemoryEventSink;
  projects: ProjectService;
  sources: SourceService;
  memory: MemoryService;
  mock: MockProvider;
  mockAccountId: string;
  defaultModel: { value: string | null };
  /** Live settings the services read (FR-019, FR-027, FR-032). */
  settings: { followUp: 'steer' | 'queue'; ttlHours: number; memoryEnabled: boolean };
  close: () => Promise<void>;
}

export interface EnvOptions {
  mock?: MockProviderOptions;
  factory?: ProviderFactory;
  chat?: Partial<ChatServiceOptions>;
  path?: string;
  /** Build the router from the registry (default: DirectRouter). */
  router?: (registry: ProviderRegistry) => ModelRouter;
  /** Give the ChatService a tool runtime (M3). */
  tools?: (base: { db: NovaDatabase; events: MemoryEventSink; dataDir: string }) => ToolRuntime;
}

export async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-core-'));
  const db = openDatabase({ path: opts.path ?? ':memory:' });
  await migrate(db, { backupDir: join(dir, 'backups') });
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT OR IGNORE INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  const secrets = new MemorySecretStore();
  const mock = new MockProvider({ id: 'mock', ...opts.mock });
  const factory: ProviderFactory = (input) =>
    opts.factory?.(input) ?? (input.row.provider === 'mock' ? mock : undefined);
  const registry = new ProviderRegistry({ db, secrets, factory });
  const router: ModelRouter = opts.router?.(registry) ?? new DirectRouter(registry);
  const defaultModel = { value: null as string | null };
  const settings: Env['settings'] = { followUp: 'queue', ttlHours: 24, memoryEnabled: true };
  const events = new MemoryEventSink();
  const threads = new ThreadService({
    db,
    router,
    events,
    defaultModel: () => Promise.resolve(defaultModel.value),
  });
  const dataDir = join(dir, 'data');
  const projects = new ProjectService({ db });
  const sources = new SourceService({ db, events, dataDir });
  const memory = new MemoryService({
    db,
    events,
    enabled: () => Promise.resolve(settings.memoryEnabled),
  });
  const tools = opts.tools?.({ db, events, dataDir });
  const chat = new ChatService({
    db,
    router,
    threads,
    events,
    dataDir,
    deltaIntervalMs: 0,
    flushIntervalMs: 20,
    memory,
    sources,
    settings: {
      followUp: () => Promise.resolve(settings.followUp),
      temporaryTtlHours: () => Promise.resolve(settings.ttlHours),
    },
    ...(tools ? { tools } : {}),
    ...opts.chat,
  });
  const created = await registry.ensureDefaultProvider(ACCOUNT);
  return {
    db,
    dir,
    secrets,
    registry,
    router,
    threads,
    chat,
    events,
    projects,
    sources,
    memory,
    mock,
    mockAccountId: created?.id ?? '',
    defaultModel,
    settings,
    close: async () => {
      await chat.shutdown();
      await tools?.close();
      await sources.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

export const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

/** Smallest valid PNG header bytes (enough for the magic check). */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// ---- M3 tool environment -------------------------------------------------------------------

export interface ToolEnvOptions extends Omit<EnvOptions, 'tools'> {
  gate?: ToolGate;
  sandbox?: SandboxClient;
  sources?: ToolSourceProvider[];
  /** `search.searxngUrl`; web.search is listed only when set. */
  searxngUrl?: string | null;
  web?: Omit<WebToolOptions, 'searxngUrl'>;
  budget?: DeferBudget;
  /** Extra roots after the workspace. */
  roots?: (dir: string) => ToolRoot[];
  readOnly?: boolean;
  network?: ToolScope['network'];
}

export interface ToolEnv extends Env {
  runtime: ToolRuntime;
  artifacts: ArtifactService;
  /** The first root (writable unless readOnly). */
  workspace: string;
  audit: AuditRecord[];
  /** Mutable: change the search URL between turns. */
  web: { url: string | null };
}

export async function makeToolEnv(opts: ToolEnvOptions = {}): Promise<ToolEnv> {
  let runtime!: ToolRuntime;
  let artifacts!: ArtifactService;
  let workspace = '';
  const audit: AuditRecord[] = [];
  const web = { url: opts.searxngUrl ?? null };
  const env = await makeEnv({
    ...opts,
    tools: ({ db, events, dataDir }) => {
      workspace = join(dataDir, 'workspace');
      mkdirSync(workspace, { recursive: true });
      artifacts = new ArtifactService({ db, events, dataDir });
      const searxngUrl = () => Promise.resolve(web.url);
      const builtins = builtinTools({
        artifacts,
        searxngUrl,
        paths: { denied: [dataDir], allowed: [workspace] },
        ...(opts.web ? { web: opts.web } : {}),
      });
      const registry = new ToolRegistry({
        sources: [builtinSource(builtins, searxngUrl), ...(opts.sources ?? [])],
      });
      const access = opts.readOnly ? ('read' as const) : ('write' as const);
      runtime = new ToolRuntime({
        db,
        events,
        gate: opts.gate ?? allowAllGate,
        registry,
        sandbox: opts.sandbox ?? new UnavailableSandbox(),
        audit: { append: (r) => Promise.resolve(void audit.push(r)) },
        scope: () =>
          Promise.resolve({
            roots: [
              { path: workspace, access, label: 'Workspace' },
              ...(opts.roots?.(dataDir) ?? []),
            ],
            profile: { id: opts.readOnly ? 'read-only' : 'workspace', hash: 'test-hash' },
            network: opts.network ?? 'off',
          }),
        ...(opts.budget ? { deferBudget: () => Promise.resolve(opts.budget!) } : {}),
        paths: { denied: [dataDir], allowed: [workspace] },
      });
      return runtime;
    },
  });
  return { ...env, runtime, artifacts, workspace, audit, web };
}

/** Tool cards of a thread's messages, in order. */
export async function toolCards(env: Env, threadId: string) {
  const d = await env.threads.detail(ACCOUNT, threadId);
  return d.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_call'));
}
