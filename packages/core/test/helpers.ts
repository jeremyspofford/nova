import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type MockProviderOptions } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ChatService,
  DirectRouter,
  MemoryEventSink,
  MemoryService,
  ProjectService,
  ProviderRegistry,
  SourceService,
  ThreadService,
  type ChatServiceOptions,
  type ModelRouter,
  type ProviderFactory,
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
