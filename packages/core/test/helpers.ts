import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type MockProviderOptions } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ChatService,
  MemoryEventSink,
  ProviderRegistry,
  ThreadService,
  type ChatServiceOptions,
  type ProviderFactory,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';

export interface Env {
  db: NovaDatabase;
  dir: string;
  secrets: MemorySecretStore;
  registry: ProviderRegistry;
  threads: ThreadService;
  chat: ChatService;
  events: MemoryEventSink;
  mock: MockProvider;
  mockAccountId: string;
  defaultModel: { value: string | null };
  close: () => Promise<void>;
}

export interface EnvOptions {
  mock?: MockProviderOptions;
  factory?: ProviderFactory;
  chat?: Partial<ChatServiceOptions>;
  path?: string;
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
  const defaultModel = { value: null as string | null };
  const threads = new ThreadService({
    db,
    registry,
    defaultModel: () => Promise.resolve(defaultModel.value),
  });
  const events = new MemoryEventSink();
  const chat = new ChatService({
    db,
    registry,
    threads,
    events,
    dataDir: join(dir, 'data'),
    deltaIntervalMs: 0,
    flushIntervalMs: 20,
    ...opts.chat,
  });
  const created = await registry.ensureDefaultProvider(ACCOUNT);
  return {
    db,
    dir,
    secrets,
    registry,
    threads,
    chat,
    events,
    mock,
    mockAccountId: created?.id ?? '',
    defaultModel,
    close: async () => {
      await chat.shutdown();
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
