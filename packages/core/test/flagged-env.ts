// The M7 flagged areas' test environment (FR-202, FR-203): a migrated database with an account and
// a thread, the real policy gate over the real policy store, and the real tool runtime with a few
// demo tools, so nested script calls and external-agent operations pass exactly the path a model
// call passes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  ToolRegistry,
  ToolRuntime,
  UnavailableSandbox,
  type AuditRecord,
  type BuiltinTool,
  type SandboxClient,
  type ToolContext,
  type ToolResult,
  type ToolSourceProvider,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000f1';
export const THREAD = '01920000-0000-7000-8000-0000000000f2';
export const TURN = '01920000-0000-7000-8000-0000000000f3';

/** Migrate (0038_flagged holds the script and agent tables). */
export async function migrateFlagged(db: NovaDatabase): Promise<void> {
  await migrate(db);
}

/** A built-in demo tool; `run` answers its calls. */
export function demoTool(
  name: string,
  opts: {
    run?: (args: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
    descriptor?: Partial<ToolDescriptor>;
    origin?: BuiltinTool['origin'];
  } = {},
): BuiltinTool {
  return {
    descriptor: {
      name,
      title: name,
      description: `the ${name} tool`,
      source: 'builtin',
      inputSchema: { type: 'object' },
      loading: 'always',
      deferred: false,
      effects: [],
      ...opts.descriptor,
    },
    origin: opts.origin ?? null,
    handler: async (args, ctx) =>
      opts.run
        ? await opts.run(args, ctx)
        : { ok: true, content: [{ type: 'text', text: `${name} ${JSON.stringify(args)}` }] },
  };
}

export interface FlaggedEnv {
  dir: string;
  workspace: string;
  db: NovaDatabase;
  events: MemoryEventSink;
  audit: AuditRecord[];
  settings: Partial<Record<SettingKey, unknown>>;
  store: PolicyStore;
  gate: PolicyGate;
  runtime: ToolRuntime;
  setting: <K extends SettingKey>(key: K) => Promise<(typeof SETTINGS)[K]['default']>;
  /** Wait for the next approval and return its id. */
  nextApproval: (before: number) => Promise<string>;
  approvals: () => number;
  close: () => Promise<void>;
}

export async function flaggedEnv(
  opts: {
    tools?: BuiltinTool[] | ((at: { dir: string; workspace: string }) => BuiltinTool[]);
    sources?: (env: { db: NovaDatabase }) => ToolSourceProvider[];
    sandbox?: SandboxClient;
    mode?: 'chat' | 'work' | 'code' | 'agent';
  } = {},
): Promise<FlaggedEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'nova-flagged-'));
  const workspace = join(dir, 'data', 'workspace');
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase({ path: ':memory:' });
  await migrateFlagged(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, opts.mode ?? 'chat', now, now);
  db.raw
    .prepare(
      "INSERT INTO turn (id, thread_id, idx, execution_location, started_at, created_at, updated_at) VALUES (?, ?, 0, 'hub', ?, ?, ?)",
    )
    .run(TURN, THREAD, now, now, now);
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const setting = <K extends SettingKey>(key: K) =>
    Promise.resolve((key in settings ? settings[key] : SETTINGS[key].default) as never);
  const store = new PolicyStore({ db });
  const gate = new PolicyGate({
    store,
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    notifier: { notify: () => Promise.resolve() },
    setting,
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
  });
  const tools =
    typeof opts.tools === 'function' ? opts.tools({ dir, workspace }) : (opts.tools ?? []);
  const builtins: ToolSourceProvider = { source: 'builtin', list: () => Promise.resolve(tools) };
  const runtime = new ToolRuntime({
    db,
    events,
    gate,
    registry: new ToolRegistry({ sources: [builtins, ...(opts.sources?.({ db }) ?? [])] }),
    sandbox: opts.sandbox ?? new UnavailableSandbox(),
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    scope: () =>
      Promise.resolve({
        roots: [{ path: workspace, access: 'write', label: 'Workspace' }],
        profile: { id: 'workspace', hash: 'test-hash' },
        network: 'off',
      }),
    paths: { denied: [join(dir, 'data')], allowed: [workspace] },
  });
  const approvals = () => events.events.filter((e) => e.name === 'approval.requested').length;
  return {
    dir,
    workspace,
    db,
    events,
    audit,
    settings,
    store,
    gate,
    runtime,
    setting,
    approvals,
    nextApproval: async (before) => {
      let id = '';
      await vi.waitFor(
        () => {
          const reqs = events.events.filter((e) => e.name === 'approval.requested');
          if (reqs.length <= before) throw new Error('no approval yet');
          id = reqs.at(-1)!.payload.approvalId as string;
        },
        { timeout: 10_000, interval: 10 },
      );
      return id;
    },
    close: async () => {
      await runtime.close();
      await gate.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
