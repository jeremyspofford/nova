// Notification center (FR-013). Notifications are rows the bell lists; `notification.created`
// tells clients to refresh and lets them raise an OS notification when the user allowed it.
// A dedupe key collapses repeats of the same thing while the first is still unread (a repeat
// refreshes it instead of adding a row or pinging again). Categories the user turned off in
// `notifications.categories` are not recorded at all.
import {
  NOTIFICATION_KINDS,
  NovaError,
  uuidv7,
  type NotificationKind,
  type NotificationView,
} from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { EventSink } from '../events.ts';
import type { NotificationInput, Notifier } from '../tools/types.ts';

interface NotificationRow {
  id: string;
  account_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  dedupe_key: string | null;
  read: number;
  created_at: string;
}

export interface NotificationServiceOptions {
  db: NovaDatabase;
  events?: EventSink;
  /** Whether a category is on (`notifications.categories`); default all on. */
  enabled?: (kind: NotificationKind, accountId: string) => Promise<boolean>;
  redactor?: Redactor;
  now?: () => Date;
  /** Rows kept per account; the oldest read ones go first (default 1000). */
  keep?: number;
}

/** An in-app path only: `/x`, never `//host` or a scheme, so a click cannot leave the app. */
export function safeHref(href: string | undefined | null): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  return /^[\x21-\x7e]+$/.test(href) && href.length <= 2000 ? href : null;
}

/** Per-category routing (the channels area's NotificationRouter, FR-060). */
export interface NotificationRouting {
  /** Show it in the in-app list as unread (off: recorded read, for channel copies and history). */
  inappEnabled(accountId: string, kind: NotificationKind): boolean;
  /** Raise it on the OS now (off, or during quiet hours). */
  osEnabled(accountId: string, kind: NotificationKind): boolean;
}

export class NotificationService implements Notifier {
  #routing: NotificationRouting | null = null;
  readonly #db: NovaDatabase;
  readonly #events: EventSink | undefined;
  readonly #enabled: (kind: NotificationKind, accountId: string) => Promise<boolean>;
  readonly #redactor: Redactor;
  readonly #now: () => Date;
  readonly #keep: number;

  constructor(opts: NotificationServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#enabled = opts.enabled ?? (() => Promise.resolve(true));
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#now = opts.now ?? (() => new Date());
    this.#keep = opts.keep ?? 1000;
  }

  async notify(n: NotificationInput): Promise<void> {
    await this.create(n);
  }

  /** Wire the channels area's routing rules and quiet hours (FR-060). */
  useRouting(routing: NotificationRouting | null): void {
    this.#routing = routing;
  }

  /** Record a notification; null when its category is off. Collapsed repeats return the existing one. */
  async create(n: NotificationInput): Promise<NotificationView | null> {
    if (!(NOTIFICATION_KINDS as readonly string[]).includes(n.kind))
      throw new NovaError('validation', `unknown notification kind ${n.kind}`);
    if (!(await this.#enabled(n.kind, n.accountId))) return null;
    const title = this.#redactor.redactString(n.title).slice(0, 300) || 'Notification';
    const body = n.body ? this.#redactor.redactString(n.body).slice(0, 2000) : null;
    const href = safeHref(n.href);
    const dedupe = n.dedupeKey ? n.dedupeKey.slice(0, 300) : null;
    const now = this.#now().toISOString();
    const raw = this.#db.raw;
    let inapp = true;
    let os = true;
    try {
      inapp = this.#routing?.inappEnabled(n.accountId, n.kind) ?? true;
      os = this.#routing?.osEnabled(n.accountId, n.kind) ?? true;
    } catch {
      // Routing unreadable: the notification still shows in-app (never lost).
    }
    const read = inapp ? 0 : 1;
    const { row, created } = await this.#db.transaction(() => {
      const existing = dedupe
        ? (raw
            .prepare(
              'SELECT * FROM notification WHERE account_id = ? AND dedupe_key = ? AND read = 0',
            )
            .get(n.accountId, dedupe) as NotificationRow | undefined)
        : undefined;
      if (existing) {
        raw
          .prepare(
            'UPDATE notification SET title = ?, body = ?, href = ?, created_at = ? WHERE id = ?',
          )
          .run(title, body, href, now, existing.id);
        return {
          row: { ...existing, title, body, href, created_at: now },
          created: false,
        };
      }
      const fresh: NotificationRow = {
        id: uuidv7(),
        account_id: n.accountId,
        kind: n.kind,
        title,
        body,
        href,
        dedupe_key: dedupe,
        read,
        created_at: now,
      };
      raw
        .prepare(
          `INSERT INTO notification (id, account_id, kind, title, body, href, dedupe_key, read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(fresh.id, fresh.account_id, fresh.kind, title, body, href, dedupe, read, now);
      // Bound the table: drop the oldest beyond `keep`, read ones first.
      raw
        .prepare(
          `DELETE FROM notification WHERE account_id = ? AND id IN (
             SELECT id FROM notification WHERE account_id = ?
             ORDER BY read DESC, created_at ASC
             LIMIT max(0, (SELECT count(*) FROM notification WHERE account_id = ?) - ?))`,
        )
        .run(n.accountId, n.accountId, n.accountId, this.#keep);
      return { row: fresh, created: true };
    });
    if (created) {
      await this.#events?.emit({
        name: 'notification.created',
        accountId: n.accountId,
        // `os`: whether clients may raise it on the OS now (routing and quiet hours).
        payload: { notificationId: row.id, kind: row.kind, title: row.title, os: inapp && os },
      });
    }
    return toView(row);
  }

  /** Newest first, at most `limit` (default 200), with the account's unread count. */
  list(
    accountId: string,
    q: { unread?: boolean; limit?: number } = {},
  ): Promise<{ items: NotificationView[]; unread: number }> {
    const limit = Math.max(1, Math.min(q.limit ?? 200, 200));
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM notification WHERE account_id = ? ${q.unread ? 'AND read = 0' : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(accountId, limit) as unknown as NotificationRow[];
    return Promise.resolve({ items: rows.map(toView), unread: this.#unread(accountId) });
  }

  /** Mark some (or all) as read; returns the unread count after. */
  async markRead(accountId: string, q: { ids?: string[]; all?: boolean }): Promise<number> {
    await this.#db.transaction(() => {
      if (q.all) {
        this.#db.raw
          .prepare('UPDATE notification SET read = 1 WHERE account_id = ? AND read = 0')
          .run(accountId);
        return;
      }
      const ids = q.ids ?? [];
      if (!ids.length) return;
      this.#db.raw
        .prepare(
          `UPDATE notification SET read = 1 WHERE account_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        )
        .run(accountId, ...ids);
    });
    return this.#unread(accountId);
  }

  async remove(accountId: string, id: string): Promise<void> {
    const res = await this.#db.transaction(() =>
      this.#db.raw
        .prepare('DELETE FROM notification WHERE account_id = ? AND id = ?')
        .run(accountId, id),
    );
    if (res.changes === 0) throw new NovaError('not_found', 'notification not found');
  }

  #unread(accountId: string): number {
    const r = this.#db.raw
      .prepare('SELECT count(*) AS n FROM notification WHERE account_id = ? AND read = 0')
      .get(accountId) as { n: number };
    return r.n;
  }
}

function toView(r: NotificationRow): NotificationView {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    href: r.href,
    read: r.read === 1,
    createdAt: r.created_at,
  };
}
