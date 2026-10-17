// Notification center entry in the top bar (FR-013, docs/04 §6): a button with the unread count
// that opens a panel to read, open, mark read and delete notifications. It follows
// `notification.created` on the global event stream (its own EventSource) and, while the page is
// hidden and the user allowed it, also shows an OS notification. Categories turned off in
// Settings → Notifications are neither listed nor sent to the OS.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { NotificationKind, NotificationView } from '@nova/shared';
import { Button, Icon, IconButton, Spinner, VisuallyHidden, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { openStream } from '../sse.ts';
import { OPEN_NOTIFICATIONS_EVENT } from '../workspace-commands.ts';
import { showOsNotification } from './os.ts';
import '../workspace.css';

export const EVENTS_STREAM_URL = '/api/v1/events/stream';

export const KIND_TEXT: Record<NotificationKind, string> = {
  approval: 'Approval',
  completion: 'Finished',
  error: 'Error',
  attention: 'Needs attention',
  system: 'System',
};

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
        announce(`New notification: ${n.title}`);
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
            setError(errorMessage(err, 'Could not load notifications.'));
          },
        );
      };
      run(fromEvent);
    },
    [api, apply],
  );

  useEffect(() => {
    refresh(false);
    const handle = openStream(
      EVENTS_STREAM_URL,
      { onEvent: () => refresh(true) },
      { names: ['notification.created'], factory: eventSource },
    );
    return () => handle.close();
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
      toast.show(`Could not mark it read: ${errorMessage(err)}`, { tone: 'error' });
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
      toast.show(`Could not mark them read: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = async (n: NotificationView) => {
    try {
      await api.deleteNotification(n.id);
      setItems((list) => list?.filter((x) => x.id !== n.id) ?? null);
      if (!n.read) setServerUnread((u) => Math.max(0, u - 1));
    } catch (err) {
      toast.show(`Could not delete it: ${errorMessage(err)}`, { tone: 'error' });
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
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {unread ? (
          <span className="bell-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-labelledby={`${panelId}-title`} className="bell-panel">
          <div className="bell-head">
            <h2 id={`${panelId}-title`} ref={heading} tabIndex={-1}>
              Notifications
            </h2>
            <Button variant="ghost" disabled={!unread} onClick={() => void markAll()}>
              Mark all read
            </Button>
          </div>
          {error ? (
            <div role="alert" className="ws-error">
              <p>{error}</p>
              <Button onClick={() => refresh(false)}>Retry</Button>
            </div>
          ) : null}
          {items === null && !error ? <Spinner label="Loading notifications" /> : null}
          {items !== null && shown.length === 0 ? (
            <p className="muted bell-empty">No notifications.</p>
          ) : null}
          {shown.length ? (
            <ul className="bell-list" aria-label="Notifications">
              {shown.map((n) => (
                <li
                  key={n.id}
                  className="bell-item"
                  data-unread={!n.read || undefined}
                  aria-label={n.title}
                >
                  <button type="button" className="bell-item-main" onClick={() => follow(n)}>
                    <span className="bell-item-title">
                      {!n.read ? <VisuallyHidden>Unread:</VisuallyHidden> : null} {n.title}
                    </span>{' '}
                    {n.body ? <span className="bell-item-body">{n.body}</span> : null}{' '}
                    <span className="muted bell-item-meta">
                      {KIND_TEXT[n.kind]} · {formatWhen(n.createdAt)}
                    </span>
                  </button>
                  <div className="row bell-item-actions">
                    {!n.read ? (
                      <Button variant="ghost" onClick={() => void markRead(n)}>
                        Mark read
                      </Button>
                    ) : null}
                    <IconButton
                      variant="ghost"
                      label={`Delete ${n.title}`}
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
