import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { EVENTS_STREAM_URL, safeHref } from '../src/notifications/Bell.tsx';
import { osPermission, requestOsPermission, showOsNotification } from '../src/notifications/os.ts';
import { workspaceCommands } from '../src/workspace-commands.ts';
import { FakeEventSource, createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { notification } from './fakes-settings.ts';
import { renderApp, resetDom } from './render.tsx';

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });

/** A scriptable stand-in for the browser's Notification API. */
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static next: NotificationPermission = 'granted';
  static shown: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => {
    await Promise.resolve();
    FakeNotification.permission = FakeNotification.next;
    return FakeNotification.permission;
  });
  onclick: (() => void) | null = null;
  closed = false;
  readonly title: string;
  readonly options: NotificationOptions;
  constructor(title: string, options: NotificationOptions = {}) {
    this.title = title;
    this.options = options;
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

function setHidden(hidden: boolean) {
  if (hidden)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  else delete (document as { visibilityState?: unknown }).visibilityState;
}

beforeEach(() => {
  FakeNotification.permission = 'default';
  FakeNotification.next = 'granted';
  FakeNotification.shown = [];
  FakeNotification.requestPermission.mockClear();
});

afterEach(() => {
  resetDom();
  setHidden(false);
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

const bell = () => screen.getByRole('button', { name: /^Notifications/ });
/** The bell's own stream: the Work surfaces hold a second one on the same URL (M5). */
const bellStream = () => {
  const s = FakeEventSource.all.find(
    (x) =>
      !x.closed && x.url.includes(EVENTS_STREAM_URL) && x.listeners.has('notification.created'),
  );
  if (!s) throw new Error('no notification stream');
  return s;
};

describe('notification helpers (FR-013)', () => {
  it('follows only same-origin app paths', () => {
    expect(safeHref('/chat/t1?m=m2')).toBe('/chat/t1?m=m2');
    expect(safeHref('https://evil.example')).toBeNull();
    expect(safeHref('//evil.example/x')).toBeNull();
    expect(safeHref('/\\evil.example')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it('reports and requests OS permission', async () => {
    expect(osPermission()).toBe('unsupported');
    expect(await requestOsPermission()).toBe('unsupported');
    vi.stubGlobal('Notification', FakeNotification);
    expect(osPermission()).toBe('default');
    expect(await requestOsPermission()).toBe('granted');
    FakeNotification.requestPermission.mockRejectedValueOnce(new Error('blocked'));
    FakeNotification.permission = 'denied';
    expect(await requestOsPermission()).toBe('denied');
  });

  it('shows an OS notification only while hidden and allowed', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    const n = notification({ title: 'Approval needed', body: 'Write plan.md', href: '/chat/t1' });
    const onClick = vi.fn();
    FakeNotification.permission = 'granted';
    expect(await showOsNotification(n, onClick)).toBe(false); // visible
    setHidden(true);
    FakeNotification.permission = 'denied';
    expect(await showOsNotification(n, onClick)).toBe(false);
    FakeNotification.permission = 'granted';
    expect(await showOsNotification(n, onClick)).toBe(true);
    const shown = FakeNotification.shown[0]!;
    expect(shown.title).toBe('Approval needed');
    expect(shown.options).toMatchObject({ body: 'Write plan.md', tag: n.id });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    shown.onclick?.();
    expect(onClick).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(shown.closed).toBe(true);
  });

  it('uses the service worker for an installed app and when page notifications are refused', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: () => Promise.resolve({ showNotification }) },
    });
    setHidden(true);
    const n = notification({ title: 'Done' });
    // A browser that allows only service-worker notifications.
    class Refusing {
      static permission = 'granted';
      constructor() {
        throw new TypeError('Illegal constructor');
      }
    }
    vi.stubGlobal('Notification', Refusing);
    expect(await showOsNotification(n, () => undefined)).toBe(true);
    expect(showNotification).toHaveBeenCalledWith('Done', { tag: n.id, data: { href: null } });
    // Installed (standalone) apps go straight to the service worker.
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') }));
    expect(await showOsNotification(n, () => undefined)).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(FakeNotification.shown).toHaveLength(0);
    // No registration and no page notifications: nothing is shown.
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('Notification', Refusing);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: () => Promise.resolve(undefined) },
    });
    expect(await showOsNotification(n, () => undefined)).toBe(false);
  });

  it('registers a Show notifications command', () => {
    const show = vi.fn();
    const cmd = workspaceCommands({ showNotifications: show }).find(
      (c) => c.id === 'notifications.open',
    )!;
    expect(cmd.title).toBe('Show notifications');
    cmd.run();
    expect(show).toHaveBeenCalled();
  });
});

describe('notification center (FR-013)', () => {
  const hubWith = () =>
    createHub({
      m3: m3State({
        notifications: [
          notification({
            id: 'n1',
            kind: 'approval',
            title: 'Approval needed: write plan.md',
            body: 'In “Trip planning”',
            href: '/chat/t1',
          }),
          notification({ id: 'n2', title: 'Reply finished', read: true }),
          notification({ id: 'n3', kind: 'error', title: 'Server files crashed' }),
        ],
      }),
    });

  it('shows the unread count and reads, marks, deletes and follows notifications', async () => {
    const hub = hubWith();
    await renderApp({ hub });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread'));
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(document.activeElement?.textContent).toBe('Notifications');
    const n3 = within(panel).getByRole('listitem', { name: 'Server files crashed' });
    expect(within(n3).getByText(/Error ·/)).toBeTruthy();
    expect(
      within(n3).getByRole('button', { name: /^Unread: Server files crashed Error · / }),
    ).toBeTruthy();

    await userEvent.click(within(n3).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread'));
    expect(within(n3).queryByRole('button', { name: 'Mark read' })).toBeNull();

    await userEvent.click(within(panel).getByRole('button', { name: 'Delete Reply finished' }));
    await waitFor(() =>
      expect(within(panel).queryByRole('listitem', { name: 'Reply finished' })).toBeNull(),
    );
    expect(hub.state.m3.notifications.map((n) => n.id)).toEqual(['n1', 'n3']);

    await userEvent.click(
      within(panel).getByRole('button', { name: /^Unread: Approval needed: write plan.md/ }),
    );
    expect(window.location.pathname).toBe('/chat/t1');
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications'));
    expect(hub.api.markNotificationsRead).toHaveBeenLastCalledWith({ ids: ['n1'] });
  });

  it('marks all read, closes on Escape and outside clicks, and opens from the command', async () => {
    const hub = hubWith();
    const { registry } = await renderApp({ hub });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread'));
    act(() => {
      registry.run('notifications.open');
    });
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications'));
    expect(hub.api.markNotificationsRead).toHaveBeenCalledWith({ all: true });
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: 'Mark all read' }).disabled,
    ).toBe(true);
    expect(document.activeElement?.textContent).toBe('Notifications');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
    expect(document.activeElement).toBe(bell());
    await userEvent.click(bell());
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    await userEvent.click(screen.getByRole('navigation', { name: 'Sidebar' }));
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
  });

  it('follows notification.created on the global stream and pops an OS notification when hidden', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    const hub = hubWith();
    await renderApp({ hub });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread'));
    const es = bellStream();
    expect(hub.api.listNotifications).toHaveBeenCalledTimes(1);

    // Visible page: the bell updates and the change is announced, but no OS notification.
    hub.state.m3.notifications = [
      notification({ id: 'n4', kind: 'completion', title: 'Run finished' }),
      ...hub.state.m3.notifications,
    ];
    es.emit('notification.created', { notificationId: 'n4', kind: 'completion', title: 'x' });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 3 unread'));
    expect(screen.getByTestId('announcer').textContent).toContain('New notification: Run finished');
    expect(FakeNotification.shown).toHaveLength(0);

    // Hidden page: an OS notification; clicking it opens the target.
    setHidden(true);
    hub.state.m3.notifications = [
      notification({ id: 'n5', kind: 'approval', title: 'Approve a purchase', href: '/chat/t9' }),
      ...hub.state.m3.notifications,
    ];
    es.emit('notification.created', { notificationId: 'n5', kind: 'approval', title: 'x' });
    await waitFor(() => expect(FakeNotification.shown).toHaveLength(1));
    const os = FakeNotification.shown[0]!;
    expect(os.title).toBe('Approve a purchase');
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    act(() => os.onclick?.());
    expect(window.location.pathname).toBe('/chat/t9');

    // A replayed event for something already known pops nothing.
    es.emit('notification.created', { notificationId: 'n5', kind: 'approval', title: 'x' });
    await waitFor(() => expect(hub.api.listNotifications).toHaveBeenCalledTimes(4));
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it('does not raise a notification on the OS when routing or quiet hours say so (FR-060)', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    setHidden(true);
    const hub = hubWith();
    await renderApp({ hub });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread'));
    hub.state.m3.notifications = [
      notification({ id: 'n7', kind: 'completion', title: 'Quiet one' }),
      ...hub.state.m3.notifications,
    ];
    bellStream().emit('notification.created', {
      notificationId: 'n7',
      kind: 'completion',
      title: 'x',
      os: false,
    });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 3 unread'));
    expect(screen.getByTestId('announcer').textContent).toContain('New notification: Quiet one');
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('hides categories turned off and never sends them to the OS', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    setHidden(true);
    const hub = hubWith();
    hub.state.settings['notifications.categories'] = {
      approval: true,
      completion: true,
      error: false,
      attention: true,
      system: true,
    };
    await renderApp({ hub });
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread'));
    hub.state.m3.notifications = [
      notification({ id: 'n6', kind: 'error', title: 'Another failure' }),
      ...hub.state.m3.notifications,
    ];
    bellStream().emit('notification.created', {
      notificationId: 'n6',
      kind: 'error',
      title: 'x',
    });
    await waitFor(() => expect(hub.api.listNotifications).toHaveBeenCalledTimes(2));
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(FakeNotification.shown).toHaveLength(0);
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(within(panel).queryByRole('listitem', { name: 'Server files crashed' })).toBeNull();
    expect(within(panel).getByRole('listitem', { name: /Approval needed/ })).toBeTruthy();
  });

  it('reports load, mark and delete failures', async () => {
    const hub = hubWith();
    hub.state.failNext.listNotifications = fail('Hub unreachable');
    await renderApp({ hub });
    await userEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(await within(panel).findByText('Hub unreachable')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    const n3 = await within(panel).findByRole('listitem', { name: 'Server files crashed' });
    hub.state.failNext.markNotificationsRead = fail('Nope');
    await userEvent.click(within(n3).getByRole('button', { name: 'Mark read' }));
    expect(await screen.findByText('Could not mark it read: Nope')).toBeTruthy();
    hub.state.failNext.markNotificationsRead = fail('Still no');
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByText('Could not mark them read: Still no')).toBeTruthy();
    hub.state.failNext.deleteNotification = fail('Locked');
    await userEvent.click(
      within(panel).getByRole('button', { name: 'Delete Server files crashed' }),
    );
    expect(await screen.findByText('Could not delete it: Locked')).toBeTruthy();
    expect(within(panel).getByRole('listitem', { name: 'Server files crashed' })).toBeTruthy();
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread');
  });

  it('shows an empty panel', async () => {
    await renderApp({ hub: createHub() });
    await userEvent.click(bell());
    expect(await screen.findByText('No notifications.')).toBeTruthy();
  });
});

describe('Settings → Notifications (FR-013)', () => {
  it('turns categories off and on', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/notifications' });
    const errors = await screen.findByRole('switch', { name: 'Errors' });
    expect(errors.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(errors);
    await waitFor(() =>
      expect(hub.state.settings['notifications.categories']).toEqual({
        approval: true,
        completion: true,
        error: false,
        attention: true,
        system: true,
      }),
    );
    hub.state.failNext.setSetting = fail('Read-only database');
    await userEvent.click(screen.getByRole('switch', { name: 'System' }));
    expect(await screen.findByText('Could not save: Read-only database')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'System' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('locks managed categories', async () => {
    const hub = createHub({
      managed: {
        'notifications.categories': {
          approval: true,
          completion: false,
          error: true,
          attention: true,
          system: true,
        },
      },
    });
    await renderApp({ hub, path: '/settings/notifications' });
    const done = await screen.findByRole<HTMLButtonElement>('switch', { name: 'Finished work' });
    expect(done.disabled).toBe(true);
    expect(done.getAttribute('aria-checked')).toBe('false');
  });

  it('reports a browser without notifications', async () => {
    await renderApp({ hub: createHub(), path: '/settings/notifications' });
    expect(await screen.findByText('This browser cannot show notifications.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow notifications on this device' })).toBeNull();
  });

  it('asks for OS permission and reports the result', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    await renderApp({ hub: createHub(), path: '/settings/notifications' });
    expect(
      await screen.findByText('Notifications are not allowed on this device yet.'),
    ).toBeTruthy();
    FakeNotification.next = 'denied';
    await userEvent.click(
      screen.getByRole('button', { name: 'Allow notifications on this device' }),
    );
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(await screen.findByText(/Notifications are blocked on this device/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow notifications on this device' })).toBeNull();
  });

  it('shows granted permission', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    await renderApp({ hub: createHub(), path: '/settings/notifications' });
    expect(await screen.findByText('Notifications are allowed on this device.')).toBeTruthy();
  });
});
