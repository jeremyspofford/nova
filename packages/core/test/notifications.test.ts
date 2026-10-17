import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, makeEvent, type NewEvent, type NotificationKind } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  NotificationService,
  notificationFor,
  notifyOnEvents,
  safeHref,
  type NotificationInput,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000b1';
const OTHER = '01920000-0000-7000-8000-0000000000b2';

let db: NovaDatabase;
let events: MemoryEventSink;
let off: Set<NotificationKind>;
let clock: number;
let svc: NotificationService;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  events = new MemoryEventSink();
  off = new Set();
  clock = Date.UTC(2026, 9, 17);
  svc = new NotificationService({
    db,
    events,
    enabled: (kind) => Promise.resolve(!off.has(kind)),
    now: () => new Date((clock += 1000)),
  });
});
afterEach(() => db.close());

const n = (over: Partial<NotificationInput> = {}): NotificationInput => ({
  accountId: ACCOUNT,
  kind: 'completion',
  title: 'Done',
  ...over,
});

describe('NotificationService', () => {
  it('records notifications, emits notification.created and lists newest first', async () => {
    const a = await svc.create(n({ title: 'First', body: 'b', href: '/chat/t1' }));
    await svc.notify(n({ title: 'Second', kind: 'error' }));
    await svc.notify(n({ accountId: OTHER, title: 'Elsewhere' }));
    expect(a).toMatchObject({ title: 'First', body: 'b', href: '/chat/t1', read: false });
    const list = await svc.list(ACCOUNT);
    expect(list.items.map((x) => x.title)).toEqual(['Second', 'First']);
    expect(list.unread).toBe(2);
    expect(events.names()).toEqual([
      'notification.created',
      'notification.created',
      'notification.created',
    ]);
    expect(events.events[0]!.payload).toEqual({
      notificationId: a!.id,
      kind: 'completion',
      title: 'First',
      os: true,
    });
  });

  it('honours turned-off categories', async () => {
    off.add('completion');
    expect(await svc.create(n())).toBeNull();
    expect((await svc.list(ACCOUNT)).items).toEqual([]);
    expect(events.events).toEqual([]);
  });

  it("follows the channels area's routing: in-app off records it read, OS off says so (FR-060)", async () => {
    const rules = { inapp: true, os: false };
    svc.useRouting({
      inappEnabled: () => rules.inapp,
      osEnabled: () => rules.os,
    });
    const quiet = await svc.create(n({ title: 'Quiet hours' }));
    expect(quiet).toMatchObject({ read: false });
    expect(events.events.at(-1)!.payload).toMatchObject({ os: false });
    rules.inapp = false;
    rules.os = true;
    const hidden = await svc.create(n({ title: 'Channel only' }));
    // Still recorded (history, channel copies), but never badges or reaches the OS.
    expect(hidden).toMatchObject({ read: true });
    expect(events.events.at(-1)!.payload).toMatchObject({ os: false });
    expect((await svc.list(ACCOUNT)).unread).toBe(1);
    // Routing that cannot be read never loses a notification.
    svc.useRouting({
      inappEnabled: () => {
        throw new Error('db gone');
      },
      osEnabled: () => true,
    });
    expect(await svc.create(n({ title: 'Kept' }))).toMatchObject({ read: false });
  });

  it('collapses repeats with the same dedupe key while unread', async () => {
    const first = await svc.create(
      n({ kind: 'approval', title: 'Approve write', dedupeKey: 'approval:1' }),
    );
    const again = await svc.create(
      n({ kind: 'approval', title: 'Approve write (again)', dedupeKey: 'approval:1' }),
    );
    expect(again!.id).toBe(first!.id);
    expect((await svc.list(ACCOUNT)).items.map((x) => x.title)).toEqual(['Approve write (again)']);
    expect(events.names()).toEqual(['notification.created']);
    // Once read, the same thing happening again is news again.
    await svc.markRead(ACCOUNT, { ids: [first!.id] });
    const later = await svc.create(
      n({ kind: 'approval', title: 'Approve write', dedupeKey: 'approval:1' }),
    );
    expect(later!.id).not.toBe(first!.id);
    expect((await svc.list(ACCOUNT)).items).toHaveLength(2);
  });

  it('marks read by id or all, filters unread, and deletes', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await svc.create(n({ title: `n${i}` })))!.id);
    expect(await svc.markRead(ACCOUNT, { ids: [ids[0]!] })).toBe(2);
    expect(await svc.markRead(ACCOUNT, { ids: [] })).toBe(2);
    expect(await svc.markRead(OTHER, { all: true })).toBe(0);
    expect((await svc.list(ACCOUNT, { unread: true })).items.map((x) => x.title)).toEqual([
      'n2',
      'n1',
    ]);
    expect(await svc.markRead(ACCOUNT, { all: true })).toBe(0);
    await svc.remove(ACCOUNT, ids[1]!);
    await expect(svc.remove(ACCOUNT, ids[1]!)).rejects.toThrow(/not found/);
    await expect(svc.remove(OTHER, ids[0]!)).rejects.toThrow(/not found/);
    expect((await svc.list(ACCOUNT, { limit: 1 })).items.map((x) => x.title)).toEqual(['n2']);
  });

  it('redacts text, drops unsafe links and validates the kind', async () => {
    const title = 'Failed: Bearer Zq7Lm2Vx9Rt4Wp8K'; // secret-scan: fake
    const v = await svc.create(n({ title, href: 'https://evil.example/' }));
    expect(v!.title).toBe('Failed: Bearer [REDACTED]');
    expect(v!.href).toBeNull();
    expect((await svc.create(n({ title: '' })))!.title).toBe('Notification');
    await expect(svc.create(n({ kind: 'nope' as NotificationKind }))).rejects.toThrow(
      /unknown notification kind/,
    );
  });

  it('keeps a bounded number per account, dropping read ones first', async () => {
    const small = new NotificationService({ db, keep: 3, now: () => new Date((clock += 1000)) });
    const first = await small.create(n({ title: 'keep-unread' }));
    const second = await small.create(n({ title: 'read-1' }));
    await small.markRead(ACCOUNT, { ids: [second!.id] });
    for (let i = 0; i < 3; i++) await small.create(n({ title: `new-${i}` }));
    const titles = (await small.list(ACCOUNT)).items.map((x) => x.title);
    expect(titles).toEqual(['new-2', 'new-1', 'new-0']);
    expect(first).not.toBeNull();
  });
});

describe('safeHref', () => {
  it('accepts in-app paths only', () => {
    expect(safeHref('/chat/abc?m=1')).toBe('/chat/abc?m=1');
    expect(safeHref('//evil.example/x')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('/a\\b')).toBeNull();
    expect(safeHref('/with space')).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(`/${'x'.repeat(2001)}`)).toBeNull();
  });
});

describe('event-driven notifications', () => {
  const ev = (e: NewEvent<Record<string, unknown>>) => makeEvent(e);

  it('maps failed turns, unreachable nodes and failing MCP servers', async () => {
    const failed = ev({
      name: 'turn.completed',
      payload: { threadId: 't 1', turnId: 'u1', status: 'failed' },
    });
    expect(await notificationFor(failed)).toEqual({
      kind: 'error',
      title: 'A reply failed',
      body: expect.any(String),
      href: '/chat/t%201',
      dedupeKey: 'turn:u1',
    });
    expect(
      (await notificationFor(failed, { threadTitle: () => Promise.resolve('Trip plan') }))?.title,
    ).toBe('A reply failed in “Trip plan”');
    expect(
      await notificationFor(
        ev({ name: 'turn.completed', payload: { threadId: 't', status: 'completed' } }),
      ),
    ).toBeNull();
    const node = ev({
      name: 'node.status.changed',
      payload: { nodeId: 'n1', status: 'unreachable' },
    });
    expect(
      await notificationFor(node, { nodeName: () => Promise.resolve('gpu-box') }),
    ).toMatchObject({
      kind: 'attention',
      title: 'gpu-box is unreachable',
      href: '/settings/devices',
      dedupeKey: 'node:n1:unreachable',
    });
    expect((await notificationFor(node))?.title).toBe('A compute node is unreachable');
    expect(
      await notificationFor(
        ev({ name: 'node.status.changed', payload: { nodeId: 'n1', status: 'active' } }),
      ),
    ).toBeNull();
    const mcp = ev({
      name: 'mcp.server.status.changed',
      payload: { serverId: 's1', name: 'files', status: 'error', error: 'spawn ENOENT' },
    });
    expect(await notificationFor(mcp)).toMatchObject({
      kind: 'error',
      title: 'MCP server files stopped working',
      body: 'spawn ENOENT',
      dedupeKey: 'mcp:s1:error',
    });
    expect(
      (
        await notificationFor(
          ev({ name: 'mcp.server.status.changed', payload: { serverId: 's1', status: 'error' } }),
        )
      )?.title,
    ).toBe('An MCP server stopped working');
    const named = ev({
      name: 'mcp.server.status.changed',
      payload: { serverId: 's2', status: 'error' },
    });
    expect(
      (await notificationFor(named, { mcpServerName: () => Promise.resolve('notes') }))?.title,
    ).toBe('MCP server notes stopped working');
    expect(
      await notificationFor(
        ev({ name: 'mcp.server.status.changed', payload: { serverId: 's1', status: 'connected' } }),
      ),
    ).toBeNull();
    expect(await notificationFor(ev({ name: 'chat.delta', payload: {} }))).toBeNull();
  });

  it('notifies from the bus, collapsing repeats and using the owner when needed', async () => {
    const bus = new EventBus();
    let owner: string | null = ACCOUNT;
    const sub = notifyOnEvents({ bus, notifier: svc, ownerAccount: () => Promise.resolve(owner) });
    const down = { nodeId: 'n1', status: 'unreachable' };
    bus.publish(ev({ name: 'node.status.changed', accountId: ACCOUNT, payload: down }));
    bus.publish(ev({ name: 'node.status.changed', accountId: ACCOUNT, payload: down }));
    bus.publish(
      ev({ name: 'turn.completed', payload: { threadId: 't1', turnId: 'u1', status: 'failed' } }),
    );
    await sub.idle();
    expect((await svc.list(ACCOUNT)).items.map((x) => x.kind)).toEqual(['error', 'attention']);
    owner = null;
    bus.publish(
      ev({ name: 'turn.completed', payload: { threadId: 't2', turnId: 'u2', status: 'failed' } }),
    );
    await sub.idle();
    expect((await svc.list(ACCOUNT)).items).toHaveLength(2);
    sub.stop();
  });
});
