import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, CodeSessionView, RunView, ThreadView } from '@nova/shared';
import { CONFIG_FILE, defaultConfig, loadConfig, saveConfig } from '../src/config.ts';
import { drawGlyph, encodePng, glyphPng } from '../src/glyph.ts';
import { changesStatus, osNotification, osNotificationFor } from '../src/notify.ts';
import {
  acceleratorLabel,
  DEFAULT_SHORTCUTS,
  parseAccelerator,
  registerShortcuts,
  shortcutProblems,
} from '../src/shortcuts.ts';
import { parseHubEvent, runEventLoop, SseParser, type HubEvent } from '../src/sse.ts';
import { statusItems, statusMenuLabel, statusSummary } from '../src/status.ts';

describe('shortcuts (docs/04 §5)', () => {
  it.each([
    ['Control+Alt+N', 'Control+Alt+N'],
    ['ctrl + alt + n', 'Control+Alt+N'],
    ['Alt+Ctrl+a', 'Control+Alt+A'],
    ['CmdOrCtrl+Alt+Shift+F5', 'CommandOrControl+Alt+Shift+F5'],
    ['Super+Alt+space', 'Alt+Super+Space'],
    ['Option+Meta+.', 'Alt+Super+.'],
    ['Control+Alt++', 'Control+Alt+Plus'],
    ['Ctrl+Ctrl+Alt+K', 'Control+Alt+K'],
  ])('%s is %s', (raw, want) => {
    expect(parseAccelerator(raw)).toEqual({ ok: true, accelerator: want });
  });

  it.each([
    'N',
    'Shift+N',
    'Control+',
    'Control+Hyper+N',
    'Control+Alt+NN',
    'A+B+C+D+E+F',
    '+',
    // Everyday and system keys a global shortcut must never take (review finding 3).
    'Control+C',
    'Control+V',
    'CommandOrControl+V',
    'Control+X',
    'Control+Z',
    'Control+Shift+Z',
    'Alt+Tab',
    'Alt+F4',
    'Super+L',
    'Control+Shift+Escape',
    'Control+Alt+Delete',
    'Alt+Ctrl+Del'.replace('Del', 'Delete'),
    'Control+Alt+T',
    'Control+Alt+F2',
    'Control+Alt+Left',
    'Cmd+Option+Escape',
    'Ctrl+Cmd+Q',
    'CommandOrControl+Alt+Escape',
  ])('refuses %j', (raw) => {
    expect(parseAccelerator(raw).ok).toBe(false);
  });

  it('reads keys the way each platform writes them', () => {
    expect(acceleratorLabel('Control+Alt+N', 'darwin')).toBe('⌃⌥N');
    expect(acceleratorLabel('CommandOrControl+Shift+K', 'darwin')).toBe('⌘⇧K');
    expect(acceleratorLabel('Control+Alt+N', 'linux')).toBe('Ctrl+Alt+N');
    expect(acceleratorLabel('Super+Space', 'win32')).toBe('Super+Space');
  });

  it('registers the defaults and reports keys another app holds, never forcing them', () => {
    const registered: string[] = [];
    const registry = {
      register: vi.fn((acc: string) => {
        if (acc === 'Control+Alt+A') return false;
        registered.push(acc);
        return true;
      }),
      unregisterAll: vi.fn(),
    };
    const views = registerShortcuts(
      {},
      registry,
      { quickChat: vi.fn(), attachWindow: vi.fn() },
      'linux',
    );
    expect(registry.unregisterAll).toHaveBeenCalledOnce();
    expect(registered).toEqual([DEFAULT_SHORTCUTS.quickChat]);
    expect(views).toEqual([
      {
        action: 'quickChat',
        accelerator: 'Control+Alt+N',
        label: 'Ctrl+Alt+N',
        registered: true,
        problem: null,
      },
      {
        action: 'attachWindow',
        accelerator: 'Control+Alt+A',
        label: 'Ctrl+Alt+A',
        registered: false,
        problem: 'conflict',
      },
    ]);
    expect(shortcutProblems(views)).toEqual([
      'Attach window: Ctrl+Alt+A is used by another app. Choose another key.',
    ]);
  });

  it('reports unbound, invalid, duplicate and throwing registrations', () => {
    const registry = {
      register: (acc: string) => {
        if (acc === 'Alt+Super+X') throw new Error('bad');
        return true;
      },
      unregisterAll: () => undefined,
    };
    const handlers = { quickChat: () => undefined, attachWindow: () => undefined };
    expect(
      registerShortcuts({ quickChat: null, attachWindow: 'Shift+A' }, registry, handlers, 'linux'),
    ).toEqual([
      { action: 'quickChat', accelerator: null, label: null, registered: false, problem: null },
      {
        action: 'attachWindow',
        accelerator: 'Shift+A',
        label: 'Shift+A',
        registered: false,
        problem: 'invalid',
      },
    ]);
    const dup = registerShortcuts(
      { quickChat: 'Ctrl+Alt+K', attachWindow: 'Alt+Ctrl+K' },
      registry,
      handlers,
      'linux',
    );
    expect(dup[1]?.problem).toBe('duplicate');
    expect(shortcutProblems(dup)).toEqual([
      'Attach window: Ctrl+Alt+K is already used by another Nova shortcut.',
    ]);
    const threw = registerShortcuts({ quickChat: 'Super+Alt+X' }, registry, handlers, 'linux');
    expect(threw[0]?.problem).toBe('conflict');
    expect(shortcutProblems([{ ...threw[0]!, problem: 'invalid' }])[0]).toMatch(
      /not a valid shortcut/,
    );
  });
});

const status = (
  s: 'needs_input' | 'blocked' | 'running' | 'ready',
  reason: string | null = null,
) => ({
  status: s,
  reason,
});

describe('status list (FR-215)', () => {
  const thread = (
    id: string,
    s: ReturnType<typeof status>,
    updatedAt: string,
    extra: Partial<ThreadView> = {},
  ) =>
    ({
      id,
      mode: 'chat',
      title: `chat ${id}`,
      archived: false,
      temporary: false,
      side: false,
      derived: s,
      updatedAt,
      ...extra,
    }) as ThreadView;
  const src = {
    threads: [
      thread('t1', status('ready'), '2026-10-01T00:00:00.000Z'),
      thread('t2', status('ready'), '2026-10-03T00:00:00.000Z', { title: null }),
      thread('t3', status('needs_input', 'Approval needed'), '2026-09-01T00:00:00.000Z'),
      thread('arch', status('needs_input'), '2026-10-05T00:00:00.000Z', { archived: true }),
      thread('run-thread', status('running'), '2026-10-05T00:00:00.000Z', { runId: 'r1' }),
      thread(
        'nostatus',
        undefined as unknown as ReturnType<typeof status>,
        '2026-08-01T00:00:00.000Z',
        { derived: undefined },
      ),
    ],
    runs: [
      {
        id: 'r1',
        title: 'Send the invoice',
        parentRunId: null,
        derived: status('blocked', 'Budget reached'),
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
      {
        id: 'r2',
        title: 'child',
        parentRunId: 'r1',
        derived: status('running'),
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    ] as RunView[],
    sessions: [
      {
        id: 's1',
        title: null,
        folder: { path: '/home/me/src/app', projectFolderId: null },
        derived: status('running'),
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
    ] as CodeSessionView[],
    agents: [
      { id: 'a1', name: 'Digest', derived: status('ready'), updatedAt: '2026-09-30T00:00:00.000Z' },
    ] as AgentView[],
  };

  it('puts Needs input first, then Blocked, Running, Ready, newest first within each', () => {
    const items = statusItems(src);
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'thread:t3',
      'run:r1',
      'session:s1',
      'thread:t2',
      'thread:t1',
      'agent:a1',
      'thread:nostatus',
    ]);
    expect(items.find((i) => i.id === 's1')).toMatchObject({ title: 'app', path: '/code/s1' });
    expect(items.find((i) => i.id === 't2')?.title).toBe('New chat');
    expect(items.find((i) => i.id === 'r1')?.path).toBe('/work/r1');
    expect(items.find((i) => i.id === 'a1')?.path).toBe('/agents/a1');
    expect(statusItems(src, 2)).toHaveLength(2);
  });

  it('summarizes and labels rows with status first', () => {
    const items = statusItems(src);
    expect(statusSummary(items)).toBe('Nova: 1 needs input, 1 blocked');
    expect(statusSummary([...items, { ...items[0]!, id: 'x' }])).toBe(
      'Nova: 2 need input, 1 blocked',
    );
    expect(statusSummary([])).toBe('Nova');
    expect(statusMenuLabel(items[0]!)).toBe('Needs input: chat t3 (Approval needed)');
    expect(statusMenuLabel({ ...items[2]!, title: 'x'.repeat(50) })).toMatch(
      /^Running: x{39}… \(Code\)$/,
    );
  });
});

describe('event stream', () => {
  it('parses SSE across chunk boundaries, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    expect(p.push(': connected\n\nid: 1\nevent: x\nda')).toEqual([]);
    expect(p.push('ta: a\r\ndata: b\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ id: '1', event: 'x', data: 'a\nb' }]);
    expect(p.push('data\n\nretry: 5\nid: bad\0id\n\n')).toEqual([
      { id: '1', event: 'message', data: '' },
    ]);
    expect(p.push('x'.repeat(1024 * 1024 + 1))).toEqual([]);
    expect(p.push('\ndata: after\n\n')).toEqual([{ id: '1', event: 'message', data: 'after' }]);
  });

  it('reads Hub events', () => {
    expect(
      parseHubEvent({
        id: null,
        event: 'message',
        data: '{"id":"e1","name":"n","payload":{"a":1}}',
      }),
    ).toEqual({
      id: 'e1',
      name: 'n',
      payload: { a: 1 },
    });
    expect(
      parseHubEvent({ id: null, event: 'message', data: '{"id":"e1","name":"n","payload":[1]}' })
        ?.payload,
    ).toEqual({});
    expect(parseHubEvent({ id: null, event: 'message', data: '{"name":"n"}' })).toBeNull();
    expect(parseHubEvent({ id: null, event: 'message', data: 'nope' })).toBeNull();
  });

  it('reconnects with backoff, resumes after the last id, and waits long while signed out', async () => {
    const ctl = new AbortController();
    const sleeps: number[] = [];
    const lastIds: (string | null)[] = [];
    const events: HubEvent[] = [];
    const states: { connected: boolean; signedOut: boolean }[] = [];
    let n = 0;
    const body = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    await runEventLoop({
      signal: ctl.signal,
      open: (lastId) => {
        lastIds.push(lastId);
        n++;
        if (n === 1)
          return Promise.resolve(
            new Response(body('id: e1\ndata: {"id":"e1","name":"a","payload":{}}\n\n'), {
              status: 200,
            }),
          );
        if (n === 2) return Promise.reject(new Error('down'));
        if (n === 3) return Promise.resolve(new Response('no', { status: 401 }));
        if (n === 4) return Promise.resolve(new Response('err', { status: 500 }));
        ctl.abort();
        return Promise.reject(new Error('aborted'));
      },
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(events.map((e) => e.name)).toEqual(['a']);
    expect(lastIds).toEqual([null, 'e1', 'e1', 'e1', 'e1']);
    expect(sleeps).toEqual([1000, 2000, 60_000, 8000]);
    expect(states).toContainEqual({ connected: true, signedOut: false });
    expect(states).toContainEqual({ connected: false, signedOut: true });
  });

  it('stops at once when aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const open = vi.fn();
    await runEventLoop({ signal: ctl.signal, open, onEvent: () => undefined });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('OS notifications (FR-013, FR-060)', () => {
  const ev = (payload: Record<string, unknown>, name = 'notification.created'): HubEvent => ({
    id: 'e',
    name,
    payload,
  });

  it('raises exactly what the Hub marks for the OS', () => {
    expect(
      osNotificationFor(
        ev({ notificationId: 'n1', kind: 'approval', title: 'Approve?', os: true }),
      ),
    ).toEqual({
      notificationId: 'n1',
      kind: 'approval',
      title: 'Approve?',
    });
    // Quiet hours, an OS rule that is off: the Hub says os: false and the shell stays quiet.
    expect(
      osNotificationFor(ev({ notificationId: 'n1', kind: 'approval', title: 'x', os: false })),
    ).toBeNull();
    expect(osNotificationFor(ev({ notificationId: 'n1', title: 'x' }))).toBeNull();
    expect(osNotificationFor(ev({ title: 'x', os: true }))).toBeNull();
    expect(
      osNotificationFor(ev({ notificationId: 'n1', title: 'x', os: true }, 'chat.delta')),
    ).toBeNull();
    expect(osNotificationFor(ev({ notificationId: 'n1', title: 'x', os: true }))?.kind).toBe(
      'info',
    );
  });

  it('opens the notification place, validated, else the chat list', () => {
    const req = { notificationId: 'n1', kind: 'attention', title: 'From event' };
    expect(
      osNotification(req, {
        id: 'n1',
        kind: 'attention',
        title: 'Stored',
        body: 'Body',
        href: '/approvals/a1',
        read: false,
        createdAt: '',
      }),
    ).toEqual({ title: 'Stored', body: 'Body', path: '/approvals/a1' });
    expect(osNotification(req, null)).toEqual({ title: 'From event', body: '', path: '/chat' });
    expect(
      osNotification(req, {
        id: 'n1',
        kind: 'attention',
        title: 'S',
        body: null,
        href: 'https://evil.example/',
        read: false,
        createdAt: '',
      }).path,
    ).toBe('/chat');
  });

  it('knows which events change the status list', () => {
    expect(changesStatus(ev({}, 'thread.status.changed'))).toBe(true);
    expect(changesStatus(ev({}, 'run.updated'))).toBe(true);
    expect(changesStatus(ev({}, 'chat.delta'))).toBe(false);
  });
});

describe('tray glyph', () => {
  function decode(png: Buffer) {
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    return { width, height, raw };
  }

  it('encodes a valid RGBA PNG of the glyph', () => {
    const png = glyphPng(32);
    const { width, height, raw } = decode(png);
    expect([width, height]).toEqual([32, 32]);
    expect(raw.length).toBe((32 * 4 + 1) * 32);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('draws an opaque disc in colour, and black ink on transparency as a template', () => {
    const color = drawGlyph(32);
    const center = (16 * 32 + 16) * 4;
    expect(color[center + 3]).toBe(255);
    const template = drawGlyph(32, { template: true });
    expect(template[3]).toBe(0); // corner: transparent
    expect(template[center]).toBe(0); // the core dot is black
    expect(template[center + 3]).toBeGreaterThan(200);
    const badge = drawGlyph(32, { badge: true });
    const corner = ((32 - 6) * 32 + (32 - 6)) * 4;
    expect([badge[corner], badge[corner + 1], badge[corner + 2]]).toEqual([245, 158, 11]);
  });

  it('refuses bad sizes and mismatched pixel data', () => {
    expect(() => drawGlyph(4)).toThrow(RangeError);
    expect(() => encodePng(new Uint8Array(3), 1, 1)).toThrow(RangeError);
  });
});

describe('shell settings file', () => {
  it('starts from defaults and keeps what was saved, readable by this user only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-shell-cfg-'));
    expect(loadConfig(dir)).toEqual({ config: defaultConfig(), problem: null });
    const config = {
      ...defaultConfig(),
      hub: { url: 'https://hub.local:7443', pin: 'A'.repeat(43), caSha256: 'a'.repeat(64) },
      shortcuts: { quickChat: 'Control+Alt+K', attachWindow: null },
    };
    saveConfig(join(dir, 'nested'), config);
    expect(loadConfig(join(dir, 'nested')).config).toEqual(config);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'nested', CONFIG_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'nested', CONFIG_FILE), 'utf8'))).toMatchObject({
      v: 1,
    });
  });

  it('sets a damaged file aside and uses the defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-shell-cfg-'));
    writeFileSync(join(dir, CONFIG_FILE), '{"v":1,"hub":{"url":"nope"}}');
    const res = loadConfig(dir);
    expect(res.config).toEqual(defaultConfig());
    expect(res.problem).toMatch(/damaged/);
    expect(readdirSync(dir).some((f) => f.startsWith(`${CONFIG_FILE}.damaged-`))).toBe(true);
  });

  it('never writes an invalid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-shell-cfg-'));
    expect(() =>
      saveConfig(dir, { ...defaultConfig(), hub: { url: 'x', pin: 'y', caSha256: null } }),
    ).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
