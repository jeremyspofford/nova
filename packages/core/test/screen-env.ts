// Shared setup for the screen tests: a database with every migration (0027_screen included), a
// simulated clock, a fake computer provider over mock desktops, a fake browser, and recorders
// for audit and the pause/resume hooks.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { MemoryEventSink } from '../src/events.ts';
import type {
  BrowserAction,
  BrowserController,
  Computer,
  ComputerProvider,
} from '../src/computers/types.ts';
import {
  MockDesktops,
  ScreenService,
  type BrowserTakeoverEvent,
  type ControlTier,
  type MockDesktopOptions,
  type ScreenPauseReason,
} from '../src/screen/index.ts';
import type { AuditRecord } from '../src/tools/types.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';
export const OTHER = '01920000-0000-7000-8000-000000000002';
export const PC = 'computer-1';
export const BARE = 'computer-bare';
/** A computer whose desktop refuses every observation (as when masking fails on a device). */
export const BROKEN = 'computer-broken';
export const THREAD = '01920000-0000-7000-8000-0000000000a1';
export const T0 = Date.parse('2026-10-17T10:00:00.000Z');

export async function openScreenDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date(T0).toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'agent', 'idle', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  return db;
}

export class FakeBrowser implements BrowserController {
  readonly actions: BrowserAction[] = [];
  url = 'https://example.test/';
  read() {
    return Promise.resolve({ url: this.url, title: 'Example page', text: 'Example', elements: [] });
  }
  act(action: BrowserAction) {
    this.actions.push(action);
    if (action.kind === 'navigate') this.url = action.url;
    return Promise.resolve({ ok: true, page: null });
  }
  screenshot() {
    // A 4x2 PNG from the mock desktop's encoder.
    return Promise.resolve(
      new MockDesktops({ width: 4, height: 2, windows: [] }).desktop('b').observe().image,
    );
  }
  close() {
    return Promise.resolve();
  }
  // The takeover hooks of the browser area's controller.
  pausedBy: string | null = null;
  readonly inputs: BrowserTakeoverEvent[] = [];
  pause(by: string) {
    this.pausedBy = by;
    return Promise.resolve();
  }
  resume() {
    this.pausedBy = null;
  }
  input(event: BrowserTakeoverEvent) {
    if (!this.pausedBy) return Promise.reject(new Error('not paused'));
    this.inputs.push(event);
    return Promise.resolve();
  }
}

export interface ScreenEnv {
  db: NovaDatabase;
  dir: string;
  clock: { t: number };
  events: MemoryEventSink;
  audit: AuditRecord[];
  hooks: { which: 'pause' | 'resume'; computerId: string; reason: ScreenPauseReason }[];
  desktops: MockDesktops;
  browser: FakeBrowser;
  overrides: Record<string, ControlTier>;
  service: ScreenService;
  computers: ComputerProvider;
  close(): void;
}

function computerOf(id: string, desktops: MockDesktops, browser: FakeBrowser | null): Computer {
  const no = () => Promise.reject(new Error('not in the screen tests'));
  return {
    id,
    kind: 'cloud',
    fs: { read: no, write: no, list: no, stat: no, delete: no, move: no },
    exec: no,
    browser: () => Promise.resolve(browser),
    screen: () =>
      Promise.resolve(
        id === BARE
          ? null
          : id === BROKEN
            ? {
                observe: () => Promise.reject(new Error('masking failed')),
                act: () => Promise.resolve({ ok: true }),
                kill: () => Promise.reject(new Error('already gone')),
              }
            : desktops.screen(id),
      ),
    snapshot: no,
    restore: no,
    status: () => Promise.resolve({ state: 'running', substrate: 'cloud_stub', detail: null }),
    stop: no,
  };
}

export async function makeScreenEnv(
  opts: { desktop?: MockDesktopOptions; observeIntervalMs?: number } = {},
): Promise<ScreenEnv> {
  const db = await openScreenDb();
  const dir = mkdtempSync(join(tmpdir(), 'nova-screen-'));
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const hooks: ScreenEnv['hooks'] = [];
  const desktops = new MockDesktops({ now, ...opts.desktop });
  const browser = new FakeBrowser();
  const overrides: Record<string, ControlTier> = {};
  const computers: ComputerProvider = {
    get: (accountId, id) =>
      Promise.resolve(
        accountId === ACCOUNT && (id === PC || id === BARE || id === BROKEN)
          ? computerOf(id, desktops, id === PC ? browser : null)
          : null,
      ),
    forAgent: () => Promise.reject(new Error('not in the screen tests')),
  };
  const service = new ScreenService({
    db,
    events,
    dataDir: dir,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    computers,
    now,
    settings: {
      grantMinutes: () => Promise.resolve(30),
      killKey: () => Promise.resolve('Escape'),
      tierOverrides: () => Promise.resolve(overrides),
    },
    control: {
      pause: (i) => (
        hooks.push({ which: 'pause', computerId: i.computerId, reason: i.reason }),
        Promise.resolve()
      ),
      resume: (i) => (
        hooks.push({ which: 'resume', computerId: i.computerId, reason: i.reason }),
        Promise.resolve()
      ),
    },
    ...(opts.observeIntervalMs !== undefined ? { observeIntervalMs: opts.observeIntervalMs } : {}),
  });
  return {
    db,
    dir,
    clock,
    events,
    audit,
    hooks,
    desktops,
    browser,
    overrides,
    service,
    computers,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A caller for the agent's tool calls. */
export function agent(signal: AbortSignal = new AbortController().signal, computerId = PC) {
  return {
    accountId: ACCOUNT,
    computerId,
    actor: 'agent:agent-1',
    threadId: THREAD,
    turnId: 'turn-1',
    callId: 'call-1',
    signal,
  };
}

/** A promise with its resolver, to hold an input event in flight. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
