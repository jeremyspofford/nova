// The browser area's test environment: a migrated database with an account and threads, the real
// policy gate over a PolicyStore, and a BrowserService on the fake driver. Approvals are answered
// with `answer` (the way the approval card would).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { SETTINGS, type SettingKey } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  type AuditRecord,
  type NotificationInput,
} from '../src/index.ts';
import {
  BrowserService,
  type BrowserCall,
  type BrowserServiceOptions,
} from '../src/browser/index.ts';
import { FakeDriver } from './browser-fake.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';
export const THREAD = '01920000-0000-7000-8000-0000000000b1';

/** Every migration (0023_browser holds the browser tables). */
export async function openBrowserDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  return db;
}

export interface BrowserEnv {
  dir: string;
  db: NovaDatabase;
  driver: FakeDriver;
  events: MemoryEventSink;
  audit: AuditRecord[];
  notes: NotificationInput[];
  settings: Partial<Record<SettingKey, unknown>>;
  store: PolicyStore;
  gate: PolicyGate;
  secrets: MemorySecretStore;
  service: BrowserService;
  call: (over?: Partial<BrowserCall>) => BrowserCall;
  /** Wait for the next approval and answer it like the card. */
  answer: (
    decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny_continue' | 'deny_stop',
    opts?: { alwaysHost?: string },
  ) => Promise<{ approvalId: string; tier: string; action: string; reason: string }>;
  approvals: () => {
    tool: string;
    tier: string;
    action: string;
    preview: string;
    reason: string;
  }[];
  close: () => Promise<void>;
}

export async function makeBrowserEnv(
  over: Partial<BrowserServiceOptions> = {},
  settings: Partial<Record<SettingKey, unknown>> = {},
): Promise<BrowserEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-browser-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  const db = await openBrowserDb();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'work', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const notes: NotificationInput[] = [];
  const values: Partial<Record<SettingKey, unknown>> = {
    'browser.allowLocalSites': false,
    ...settings,
  };
  const setting = (key: SettingKey) =>
    Promise.resolve((values[key] ?? SETTINGS[key].default) as never);
  const store = new PolicyStore({ db });
  const gate = new PolicyGate({
    store,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    setting,
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
  });
  const driver = new FakeDriver();
  const secrets = new MemorySecretStore();
  const service = new BrowserService({
    db,
    events,
    dataDir: join(dir, 'data'),
    setting,
    secrets,
    driver,
    store,
    gate,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    requireEgress: false,
    ...over,
  });
  let calls = 0;
  const call = (o: Partial<BrowserCall> = {}): BrowserCall => ({
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${++calls}`,
    projectId: null,
    mode: 'work',
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    signal: new AbortController().signal,
    ...o,
  });
  const answer: BrowserEnv['answer'] = async (decision, opts = {}) => {
    let row: { id: string; tier: string; requested_action: string; reason: string } | undefined;
    await vi.waitFor(() => {
      row = db.raw
        .prepare(
          "SELECT id, tier, requested_action, reason FROM approval WHERE status = 'pending' ORDER BY created_at, id LIMIT 1 OFFSET 0",
        )
        .get() as typeof row;
      expect(row).toBeTruthy();
    });
    const r = row!;
    await gate.decide(
      ACCOUNT,
      {
        approvalId: r.id,
        decision,
        ...(decision === 'allow_always'
          ? {
              alwaysScope: opts.alwaysHost
                ? { kind: 'host' as const, host: opts.alwaysHost }
                : { kind: 'tool' as const, tool: 'browser.site' },
            }
          : {}),
      },
      'user',
    );
    return { approvalId: r.id, tier: r.tier, action: r.requested_action, reason: r.reason };
  };
  const approvals = () =>
    (
      db.raw
        .prepare(
          'SELECT tool_name, tier, requested_action, args_preview, reason FROM approval ORDER BY created_at, id',
        )
        .all() as {
        tool_name: string;
        tier: string;
        requested_action: string;
        args_preview: string;
        reason: string;
      }[]
    ).map((a) => ({
      tool: a.tool_name,
      tier: a.tier,
      action: a.requested_action,
      preview: a.args_preview,
      reason: a.reason,
    }));
  return {
    dir,
    db,
    driver,
    events,
    audit,
    notes,
    settings: values,
    store,
    gate,
    secrets,
    service,
    call,
    answer,
    approvals,
    close: async () => {
      await service.close();
      await gate.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
