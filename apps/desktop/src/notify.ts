// OS notifications from the shell (FR-013, FR-060): the Hub decides with `notification.created`'s
// `os` flag, which already folds in the category's OS rule, quiet hours and a rule that bypasses
// them, so the shell raises exactly those and second-guesses nothing. The shell owns OS
// notifications for its windows (the web UI's own are turned off there), so each shows once.
import type { NotificationView } from '@nova/shared';
import { appPath } from './routes.ts';
import type { HubEvent } from './sse.ts';

export interface OsNotificationRequest {
  notificationId: string;
  kind: string;
  title: string;
}

/** The OS notification an event asks for, or null when none may be raised now. */
export function osNotificationFor(e: HubEvent): OsNotificationRequest | null {
  if (e.name !== 'notification.created') return null;
  const p = e.payload;
  if (p.os !== true) return null;
  if (typeof p.notificationId !== 'string' || typeof p.title !== 'string') return null;
  return {
    notificationId: p.notificationId,
    kind: typeof p.kind === 'string' ? p.kind : 'info',
    title: p.title.slice(0, 200),
  };
}

export interface OsNotification {
  title: string;
  body: string;
  /** The app path a click opens (validated); the chat list when the Hub gave none. */
  path: string;
}

/** What to show: the stored notification when it could be read, else the event's own title. */
export function osNotification(
  req: OsNotificationRequest,
  stored: NotificationView | null,
): OsNotification {
  return {
    title: (stored?.title ?? req.title).slice(0, 200),
    body: (stored?.body ?? '').slice(0, 500),
    path: appPath(stored?.href ?? '') ?? '/chat',
  };
}

/** Events that change what the status list shows (FR-215). */
export function changesStatus(e: HubEvent): boolean {
  return (
    e.name === 'thread.status.changed' ||
    e.name === 'chat.message.completed' ||
    e.name.startsWith('run.') ||
    e.name.startsWith('agent.status')
  );
}
