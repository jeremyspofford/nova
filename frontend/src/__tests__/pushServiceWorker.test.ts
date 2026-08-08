/** push-sw.js: the tap must carry WHICH notification was tapped.
 *
 *  Jeremy, 2026-08-07: "I get push notifications from the PWA but when I click
 *  on it, it brings me to chat but doesn't show me what the push notification
 *  was."
 *
 *  The service worker was half of that. `notificationclick` focused the first
 *  window and called `WindowClient.navigate` — and on an engine that does not
 *  implement navigate (an iOS standalone PWA, which is Jeremy's actual
 *  device) the focus WAS the entire handler. The app came up on whatever it
 *  was already showing and the id was gone.
 *
 *  So the handler now uses BOTH channels, and this file pins that it does,
 *  because the failure is invisible from the code: navigate exists in the
 *  developer's browser, so the broken path is the one nobody clicks.
 *
 *  The file is plain dependency-free JS loaded into a fake `self`, which is
 *  the only way to test it — it is imported into a Workbox-generated worker
 *  at build time and has no module surface of its own. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SW_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            '../../public/push-sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

interface FakeClient {
  visibilityState: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

function makeClient(withNavigate: boolean): FakeClient {
  const c: FakeClient = {
    visibilityState: 'hidden',
    focus: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn(),
  };
  if (withNavigate) c.navigate = vi.fn().mockResolvedValue(undefined);
  return c;
}

/** Load push-sw.js against a fake ServiceWorkerGlobalScope and return the
 *  handlers it registered, plus the fakes so assertions can read them. */
function loadWorker(opts: { clients: FakeClient[]; userAgent?: string }) {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const waits: Promise<unknown>[] = [];

  const self = {
    addEventListener: (name: string, fn: Handler) => { handlers[name] = fn; },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(opts.clients),
      openWindow: (url: string) => { opened.push(url); return Promise.resolve(); },
    },
  };
  const navigator = { userAgent: opts.userAgent ?? 'Mozilla/5.0 (Macintosh)' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'navigator', SW_SOURCE)(self, navigator);

  const fire = async (name: string, event: Record<string, unknown>) => {
    const ev = { ...event, waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    handlers[name](ev);
    await Promise.all(waits.splice(0));
  };
  return { fire, shown, opened };
}

const clickEvent = (data: Record<string, unknown>) => ({
  notification: { data, close: vi.fn() },
});

describe('push-sw notificationclick', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('tells an already-open window WHICH notification was tapped', async () => {
    const client = makeClient(true);
    const { fire } = loadWorker({ clients: [client] });
    await fire('notificationclick', clickEvent({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    }));
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'nova:notification', id: 'abc-123' }));
  });

  it('THE REPORTED BUG: no WindowClient.navigate still delivers the id', async () => {
    // an iOS standalone PWA. Before this, the handler focused the window and
    // stopped — the app came up on chat with nothing about what was tapped.
    const client = makeClient(false);
    const { fire, opened } = loadWorker({
      clients: [client], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
    });
    await fire('notificationclick', clickEvent({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    }));
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'abc-123' }));
    // and it does NOT punish the missing navigate by opening a second window
    expect(opened).toEqual([]);
  });

  it('also navigates when the engine can, so a URL-only client still lands', async () => {
    const client = makeClient(true);
    const { fire } = loadWorker({ clients: [client] });
    await fire('notificationclick', clickEvent({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    }));
    expect(client.navigate).toHaveBeenCalledWith('/chat?notification=abc-123');
  });

  it('cold start opens the deep link, id and all', async () => {
    const { fire, opened } = loadWorker({ clients: [] });
    await fire('notificationclick', clickEvent({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    }));
    expect(opened).toEqual(['/chat?notification=abc-123']);
  });
});

describe('push-sw push', () => {
  const pushEvent = (payload: Record<string, unknown>) => ({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
  });

  it('carries the id and a replace-tag onto the banner', async () => {
    const { fire, shown } = loadWorker({ clients: [] });
    await fire('push', pushEvent({
      title: 'Nova heartbeat', body: 'backups have stopped',
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
      tag: 'nova-abc-123', tags: [],
    }));
    expect(shown).toHaveLength(1);
    expect(shown[0].options.data).toEqual({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    });
    // a re-push replaces its own banner instead of stacking a second copy
    expect(shown[0].options.tag).toBe('nova-abc-123');
  });

  it('a visible window gets told instead of banner-spammed', async () => {
    const visible = makeClient(true);
    visible.visibilityState = 'visible';
    const { fire, shown } = loadWorker({ clients: [visible] });
    await fire('push', pushEvent({
      title: 'Nova', body: 'something', url: '/chat?notification=abc-123',
      notification_id: 'abc-123', tags: [],
    }));
    // the in-app transcript is the surface while the app is on screen — but
    // it has to be TOLD, or the notification only appears on the next reload
    expect(shown).toHaveLength(0);
    expect(visible.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'nova:notification-arrived', id: 'abc-123' }));
  });

  it('AN ARRIVAL IS NOT A TAP: it must not use the tap message type', async () => {
    // ChatPanel maps 'nova:notification' to revealNotification, which POSTs
    // /notifications/{id}/open — the single writer of state='opened'
    // ("opened on your device") and the thing that retires the linked inbox
    // card. A push landing on a window that merely happens to be visible (a
    // second monitor, nobody in the room) is not a person reading anything.
    // These two shared a type for one commit and every such push recorded a
    // receipt nobody gave.
    const visible = makeClient(true);
    visible.visibilityState = 'visible';
    const { fire } = loadWorker({ clients: [visible] });
    await fire('push', pushEvent({
      title: 'Nova heartbeat', body: 'backups have stopped',
      url: '/chat?notification=abc-123', notification_id: 'abc-123', tags: [],
    }));
    const types = visible.postMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { type?: string }).type);
    expect(types).not.toContain('nova:notification');
    expect(types).toEqual(['nova:notification-arrived']);
  });

  it('...while a TAP still uses the type that may mark it opened', async () => {
    const client = makeClient(true);
    const { fire } = loadWorker({ clients: [client] });
    await fire('notificationclick', clickEvent({
      url: '/chat?notification=abc-123', notification_id: 'abc-123',
    }));
    const types = client.postMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { type?: string }).type);
    expect(types).toEqual(['nova:notification']);
  });

  it('iOS always shows — Safari revokes subscriptions that swallow pushes', async () => {
    const visible = makeClient(true);
    visible.visibilityState = 'visible';
    const { fire, shown } = loadWorker({
      clients: [visible], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
    });
    await fire('push', pushEvent({
      title: 'Nova', body: 'something', url: '/chat', tags: [],
    }));
    expect(shown).toHaveLength(1);
  });
});
