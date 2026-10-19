// The service worker's push and notificationclick handlers (FR-111, docs/13 §6, decisions 6-7 of
// ADR-095), run from public/sw.js itself against a fake worker scope: a push shows the title it
// carries and nothing else, keyed by the notification id; a click opens the in-app path (the run,
// the session, the approval in its thread) in an open window or a new one, never another origin;
// an approval's "All approvals" action opens the approvals page.
/* eslint-disable @typescript-eslint/require-await */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
const ORIGIN = 'https://hub.example';

type Handler = (event: Record<string, unknown>) => void;

function worker(clients: { url: string; navigate?: boolean }[] = []) {
  const handlers = new Map<string, Handler>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const focused: string[] = [];
  const navigated: string[] = [];
  const opened: string[] = [];
  const windows = clients.map((c) => ({
    url: c.url,
    focus: vi.fn(async function (this: unknown) {
      focused.push(c.url);
      return c.navigate === false
        ? { url: c.url }
        : {
            url: c.url,
            navigate: async (to: string) => {
              navigated.push(to);
              return null;
            },
          };
    }),
  }));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    skipWaiting: async () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
  const caches = { open: vi.fn(), keys: vi.fn(), match: vi.fn() };
  // The worker file itself, run in the fake scope (it is a classic script, not a module).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, vi.fn());
  const run = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        wait = p;
      },
    });
    await wait;
  };
  const push = (data: unknown) =>
    run('push', {
      data:
        data === undefined
          ? null
          : {
              json: () => (typeof data === 'string' ? JSON.parse(data) : data),
            },
    });
  const click = (data: unknown, action = '') => {
    const close = vi.fn();
    return run('notificationclick', { action, notification: { data, close } }).then(() => close);
  };
  return { handlers, shown, focused, navigated, opened, push, click };
}

const payload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: 'n1',
  category: 'completion',
  title: 'A task finished in a Work run',
  path: '/work/r1',
  link: 'nova://run/r1',
  at: '2026-10-01T12:00:00.000Z',
  ...over,
});

describe('a push', () => {
  it('shows the title it carries, keyed by the notification id, with no body', async () => {
    const w = worker();
    await w.push(payload());
    expect(w.shown).toHaveLength(1);
    const { title, options } = w.shown[0]!;
    expect(title).toBe('A task finished in a Work run');
    expect(options).toMatchObject({
      tag: 'n1',
      data: { href: '/work/r1', id: 'n1', category: 'completion' },
      requireInteraction: false,
      timestamp: Date.parse('2026-10-01T12:00:00.000Z'),
    });
    expect(options.body).toBeUndefined();
    expect(options.actions).toBeUndefined();
  });

  it('keeps an approval up with an action for every approval', async () => {
    const w = worker();
    await w.push(
      payload({
        id: 'n2',
        category: 'approval',
        title: 'Approval needed in a Code session',
        path: '/chat/t1?approval=a1',
        link: 'nova://approval/a1',
      }),
    );
    const { options } = w.shown[0]!;
    expect(options).toMatchObject({
      requireInteraction: true,
      data: { href: '/chat/t1?approval=a1' },
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'approvals', title: 'All approvals' },
      ],
    });
  });

  it('falls back to the deep link, and never to another origin', async () => {
    const w = worker();
    await w.push(payload({ path: 'https://evil.example/x', link: 'nova://code/s1' }));
    await w.push(payload({ id: 'n3', path: '//evil.example/x', link: 'nova://approval/a9' }));
    await w.push(payload({ id: 'n4', path: null, link: 'javascript:alert(1)' }));
    await w.push(payload({ id: 'n5', path: '/a\\b', link: 'nova://chat/t2' }));
    await w.push(payload({ id: 'n6', path: null, link: null, title: '   ', category: 'weird' }));
    expect(w.shown.map((s) => s.options.data)).toEqual([
      expect.objectContaining({ href: '/code/s1' }),
      expect.objectContaining({ href: '/approvals/a9' }),
      expect.objectContaining({ href: '/' }),
      expect.objectContaining({ href: '/chat/t2' }),
      expect.objectContaining({ href: '/', category: 'system' }),
    ]);
    expect(w.shown[4]!.title).toBe('Nova');
  });

  it('still shows "Nova" for a payload it cannot read', async () => {
    const w = worker();
    await w.push('not json');
    await w.push(undefined);
    await w.push({ v: 2, id: 'n1', title: 'secret' });
    await w.push({ v: 1, id: 'bad id!', title: 'secret' });
    expect(w.shown.map((s) => s.title)).toEqual(['Nova', 'Nova', 'Nova', 'Nova']);
    expect(w.shown.every((s) => (s.options.data as { href: string }).href === '/')).toBe(true);
  });

  it('cuts a long title', async () => {
    const w = worker();
    await w.push(payload({ title: 'x'.repeat(500) }));
    expect(w.shown[0]!.title).toHaveLength(120);
  });
});

describe('a click', () => {
  it('focuses an open window and takes it to the path', async () => {
    const w = worker([{ url: `${ORIGIN}/chat` }]);
    const close = await w.click({ href: '/work/r1' });
    expect(close).toHaveBeenCalled();
    expect(w.focused).toEqual([`${ORIGIN}/chat`]);
    expect(w.navigated).toEqual([`${ORIGIN}/work/r1`]);
    expect(w.opened).toEqual([]);
  });

  it('opens a window when none is open, and ignores other origins', async () => {
    const w = worker([{ url: 'https://other.example/' }]);
    await w.click({ href: '/code/s1' });
    expect(w.opened).toEqual([`${ORIGIN}/code/s1`]);
    expect(w.focused).toEqual([]);
  });

  it('opens the approvals page from the action', async () => {
    const w = worker();
    await w.click({ href: '/chat/t1?approval=a1' }, 'approvals');
    expect(w.opened).toEqual([`${ORIGIN}/approvals`]);
  });

  it('follows only safe paths, then the deep link, then the app', async () => {
    const w = worker();
    await w.click({ href: 'https://evil.example/' });
    await w.click({ href: '//evil.example/' });
    await w.click({ link: 'nova://run/r7' });
    await w.click(null);
    expect(w.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/work/r7`, `${ORIGIN}/`]);
  });

  it('works with a window that cannot navigate', async () => {
    const w = worker([{ url: `${ORIGIN}/`, navigate: false }]);
    await w.click({ href: '/work/r1' });
    expect(w.focused).toEqual([`${ORIGIN}/`]);
    expect(w.navigated).toEqual([]);
  });
});
