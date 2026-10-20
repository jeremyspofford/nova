// Notification center entry in the top bar (FR-013, docs/04 §6): a button with the unread count
// that opens a panel to read, open, mark read and delete notifications. It follows
// `notification.created` on the global event stream (its own EventSource) and, while the page is
// hidden and the user allowed it, also shows an OS notification. Categories turned off in
// Settings → Notifications are neither listed nor sent to the OS.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { NotificationKind, NotificationView } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Icon, IconButton, Spinner, VisuallyHidden, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { OPEN_NOTIFICATIONS_EVENT } from '../workspace-commands.ts';
import { showOsNotification } from './os.ts';
import '../workspace.css';
import { subscribeHubEvents } from '../hub-events.ts';

export { EVENTS_STREAM_URL } from '../hub-events.ts';

export const KIND_TEXT: Record<NotificationKind, string> = defineMessages('notifications.kind', {
  approval: 'Approval',
  completion: 'Finished',
  error: 'Error',
  attention: 'Needs attention',
  system: 'System',
});

/** The bell's words (FR-016). Notification titles and bodies are the Hub's text, shown as-is. */
export const BELL_TEXT = defineMessages('notifications', {
  notifications: 'Notifications',
  button: '{n, plural, =0 {Notifications} other {Notifications, # unread}}',
  overflow: '{n}+',
  announce: 'New notification: {title}',
  loadFailed: 'Could not load notifications.',
  markReadFailed: 'Could not mark it read: {error}',
  markAllFailed: 'Could not mark them read: {error}',
  deleteFailed: 'Could not delete it: {error}',
  markAll: 'Mark all read',
  retry: 'Retry',
  loading: 'Loading notifications',
  empty: 'No notifications.',
  unread: 'Unread:',
  markRead: 'Mark read',
  delete: 'Delete {title}',
});

type Categories = Record<NotificationKind, boolean>;

/** Only same-origin app paths are followed; notification text never sends the user elsewhere. */
export function safeHref(href: string | null): string | null {
  return href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')
    ? href
    : null;
}

export function NotificationsBell() {
  const { api, eventSource } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const categories = settings.get('notifications.categories').value;
  const panelId = `bell${useId()}`;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [serverUnread, setServerUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Ids already seen; null until the first list arrives, so a replay never pops OS notifications.
  const known = useRef<Set<string> | null>(null);
  const loading = useRef(false);
  const again = useRef(false);
  const cats = useRef<Categories>(categories);
  /** Notifications whose event said not to raise them on the OS (`os: false`). */
  const quietIds = useRef(new Set<string>());
  useEffect(() => {
    cats.current = categories;
  });

  const apply = useCallback(
    (list: NotificationView[], unread: number, fromEvent: boolean) => {
      const before = known.current;
      known.current = new Set(list.map((n) => n.id));
      setItems(list);
      setServerUnread(unread);
      setError(null);
      if (!fromEvent || !before) return;
      for (const n of list) {
        if (before.has(n.id) || n.read || !cats.current[n.kind]) continue;
        announce(BELL_TEXT.announce({ title: n.title }));
        // Routing or quiet hours said not to raise this one on the OS (FR-060).
        if (quietIds.current.has(n.id)) continue;
        void showOsNotification(n, () => {
          const href = safeHref(n.href);
          if (href) navigate(href);
        });
      }
    },
    [announce],
  );

  // Events can arrive in bursts (a reconnect replays them); one fetch at a time, then one more.
  const refresh = useCallback(
    (fromEvent: boolean) => {
      if (loading.current) {
        again.current = true;
        return;
      }
      loading.current = true;
      const run = (ev: boolean): void => {
        api.listNotifications().then(
          ({ items: list, unread }) => {
            apply(list, unread, ev);
            if (!again.current) {
              loading.current = false;
              return;
            }
            again.current = false;
            run(true);
          },
          (err: unknown) => {
            loading.current = false;
            again.current = false;
            setError(errorMessage(err, BELL_TEXT.loadFailed));
          },
        );
      };
      run(fromEvent);
    },
    [api, apply],
  );

  useEffect(() => {
    refresh(false);
    return subscribeHubEvents(eventSource, ['notification.created'], {
      onEvent: (e) => {
        const id = e.payload.notificationId;
        if (e.payload.os === false && typeof id === 'string') quietIds.current.add(id);
        refresh(true);
      },
    });
  }, [eventSource, refresh]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target))
        setOpen(false);
    };
    // Esc closes the panel wherever focus is (a button that just got disabled drops it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shown = (items ?? []).filter((n) => categories[n.kind]);
  const hiddenUnread = (items ?? []).filter((n) => !n.read && !categories[n.kind]).length;
  const unread = Math.max(0, serverUnread - hiddenUnread);

  const markRead = async (n: NotificationView) => {
    try {
      const r = await api.markNotificationsRead({ ids: [n.id] });
      setServerUnread(r.unread);
      setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
    } catch (err) {
      toast.show(BELL_TEXT.markReadFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const markAll = async () => {
    try {
      const r = await api.markNotificationsRead({ all: true });
      setServerUnread(r.unread);
      setItems((list) => list?.map((x) => ({ ...x, read: true })) ?? null);
      // The button disables itself; keep focus in the panel.
      heading.current?.focus();
    } catch (err) {
      toast.show(BELL_TEXT.markAllFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const remove = async (n: NotificationView) => {
    try {
      await api.deleteNotification(n.id);
      setItems((list) => list?.filter((x) => x.id !== n.id) ?? null);
      if (!n.read) setServerUnread((u) => Math.max(0, u - 1));
    } catch (err) {
      toast.show(BELL_TEXT.deleteFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const follow = (n: NotificationView) => {
    if (!n.read) void markRead(n);
    const href = safeHref(n.href);
    if (href) {
      setOpen(false);
      navigate(href);
    }
  };

  return (
    <div className="bell" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="nv-btn bell-button"
        data-variant="ghost"
        aria-label={BELL_TEXT.button({ n: unread })}
        title={BELL_TEXT.notifications}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {unread ? (
          <span className="bell-count" aria-hidden="true">
            {unread > 99 ? BELL_TEXT.overflow({ n: 99 }) : fmt.number(unread)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-labelledby={`${panelId}-title`} className="bell-panel">
          <div className="bell-head">
            <h2 id={`${panelId}-title`} ref={heading} tabIndex={-1}>
              {BELL_TEXT.notifications}
            </h2>
            <Button variant="ghost" disabled={!unread} onClick={() => void markAll()}>
              {BELL_TEXT.markAll}
            </Button>
          </div>
          {error ? (
            <div role="alert" className="ws-error">
              <p>{error}</p>
              <Button onClick={() => refresh(false)}>{BELL_TEXT.retry}</Button>
            </div>
          ) : null}
          {items === null && !error ? <Spinner label={BELL_TEXT.loading} /> : null}
          {items !== null && shown.length === 0 ? (
            <p className="muted bell-empty">{BELL_TEXT.empty}</p>
          ) : null}
          {shown.length ? (
            <ul className="bell-list" aria-label={BELL_TEXT.notifications}>
              {shown.map((n) => (
                <li
                  key={n.id}
                  className="bell-item"
                  data-unread={!n.read || undefined}
                  aria-label={n.title}
                >
                  <button type="button" className="bell-item-main" onClick={() => follow(n)}>
                    <span className="bell-item-title">
                      {!n.read ? <VisuallyHidden>{BELL_TEXT.unread}</VisuallyHidden> : null}{' '}
                      <span dir="auto">{n.title}</span>
                    </span>{' '}
                    {n.body ? (
                      <span className="bell-item-body" dir="auto">
                        {n.body}
                      </span>
                    ) : null}{' '}
                    <span className="muted bell-item-meta">
                      {KIND_TEXT[n.kind]} · {formatWhen(n.createdAt)}
                    </span>
                  </button>
                  <div className="row bell-item-actions">
                    {!n.read ? (
                      <Button variant="ghost" onClick={() => void markRead(n)}>
                        {BELL_TEXT.markRead}
                      </Button>
                    ) : null}
                    <IconButton
                      variant="ghost"
                      label={BELL_TEXT.delete({ title: n.title })}
                      icon={<Icon name="trash" />}
                      onClick={() => void remove(n)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
