// The push leg of notification routing (FR-111, FR-060, docs/13 §6): when a notification may be
// raised on the OS (its rule and quiet hours), it is pushed to the account's subscribed browsers
// (Web Push, encrypted to each browser) and, through the Relay, to its native apps (APNs/FCM; the
// Relay learns ids, a redacted title and the deep link only). A push says what the user chose in
// `push.detail`: by default a redacted title per category ("Approval needed in a Code session"),
// never the body, file contents or secrets. Subscriptions live in `push_subscription`; the
// browser's auth secret and the Hub's VAPID key live in the vault. Endpoints must be https on a
// host `push.webPushHosts` lists, so a subscription cannot make the Hub post anywhere else.
import { createHash } from 'node:crypto';
import {
  NovaError,
  uuidv7,
  type CreatePushSubscriptionRequest,
  type NotificationKind,
  type PushDetailLevel,
  type PushPayload,
  type PushSubscriptionView,
  type PushTestView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { AuditSink } from '../../tools/types.ts';
import type { FetchLike } from '../adapters/common.ts';
import type { ChannelSetting } from '../service.ts';
import {
  WebPushSender,
  b64url,
  fromB64url,
  generateVapidKeys,
  subscriptionKeyProblem,
  vapidFromJwk,
  type EncryptOptions,
  type VapidKeyPair,
} from './webpush.ts';

export const VAPID_SECRET_REF = 'secret://push/vapid';
const MAX_SUBSCRIPTIONS = 50;
/** The latest expiry a subscription may claim (milliseconds; 2100-01-01). */
export const MAX_PUSH_EXPIRY_MS = Date.UTC(2100, 0, 1);
/** After this many failed pushes in a row a subscription shows as failing. */
const FAILING_AFTER = 3;
const DELIVERY_RETENTION_MS = 7 * 24 * 3_600_000;

/** The Relay connector's push path (`RelayHub.pushNotify`). */
export interface NativePush {
  pushNotify(
    accountId: string,
    notification: { id: string; category: string; title: string; link: string | null },
  ): Promise<{ sent: number; skipped: number; failed: number }>;
}

export interface PushNotificationInput {
  accountId: string;
  notificationId: string;
  kind: NotificationKind;
  title: string;
  /** The notification's in-app path. */
  href: string | null;
}

export interface PushOutcome {
  webpush: { sent: number; failed: number; gone: number };
  native: { sent: number; skipped: number; failed: number } | null;
}

export interface PushServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  setting: ChannelSetting;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  fetch?: FetchLike;
  /** The public Hub address, for the VAPID contact when `push.vapidSubject` is unset. */
  publicUrl?: () => Promise<string | null>;
  /** Tests: check endpoints differently (a local fake push service on http). */
  endpointProblem?: (url: URL, hosts: readonly string[]) => string | null;
  /** Tests: reproducible ciphertext. */
  encrypt?: EncryptOptions;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  device_id: string | null;
  endpoint: string;
  p256dh: string;
  auth_ref: string;
  label: string | null;
  status: 'active' | 'failing' | 'gone';
  failures: number;
  expires_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Whether a host matches a pattern (`*.push.apple.com` covers its subdomains, not itself). */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) =>
    p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

/** A subscription endpoint the Hub may post to, or why not. */
export function endpointProblem(url: URL, hosts: readonly string[]): string | null {
  if (url.protocol !== 'https:') return 'a push endpoint must use https';
  if (url.username || url.password) return 'a push endpoint cannot carry credentials';
  if (!hostAllowed(url.hostname, hosts))
    return `${url.hostname} is not a push service this Hub sends to (push.webPushHosts)`;
  return null;
}

/** Where a notification's path lives, for the redacted title. */
function placeOf(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('/code/')) return 'a Code session';
  if (path.startsWith('/work/')) return 'a Work run';
  if (path.startsWith('/chat/')) return 'a chat';
  if (path.startsWith('/agents/')) return 'an agent';
  return null;
}

const REDACTED: Record<NotificationKind, string> = {
  approval: 'Approval needed',
  completion: 'A task finished',
  error: 'Something did not work',
  attention: 'Nova needs your attention',
  system: 'Nova',
};

/** The title a push carries (docs/13 §6): nothing, a redacted one per category, or the title. */
export function pushTitle(
  kind: NotificationKind,
  title: string,
  path: string | null,
  detail: PushDetailLevel,
): string {
  if (detail === 'none') return 'Nova';
  if (detail === 'titles') return title.slice(0, 120) || REDACTED[kind];
  const place = placeOf(path);
  return place && kind !== 'system' ? `${REDACTED[kind]} in ${place}` : REDACTED[kind];
}

const ID = '[A-Za-z0-9-]{1,64}';
const WORK = new RegExp(`^/work/(${ID})(?:[/?#]|$)`);
const CODE = new RegExp(`^/code/(?:sessions/)?(${ID})(?:[/?#]|$)`);
const CHAT = new RegExp(`^/chat/(${ID})(?:[/?#]|$)`);
const APPROVAL = new RegExp(`(?:[?&]approval=|^/approvals/)(${ID})(?:[&#/]|$)`);

/** The deep link a notification opens (decision 7): approval first, then run, code, chat. */
export function deepLink(path: string | null): string | null {
  if (!path) return null;
  const a = APPROVAL.exec(path);
  if (a) return `nova://approval/${a[1]}`;
  const w = WORK.exec(path);
  if (w) return `nova://run/${w[1]}`;
  const c = CODE.exec(path);
  if (c) return `nova://code/${c[1]}`;
  const t = CHAT.exec(path);
  if (t) return `nova://chat/${t[1]}`;
  return null;
}

const URGENCY: Record<NotificationKind, 'low' | 'normal' | 'high'> = {
  approval: 'high',
  attention: 'normal',
  error: 'normal',
  completion: 'low',
  system: 'low',
};

export class PushService {
  readonly #o: PushServiceOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #sender: WebPushSender;
  #vapidKeys: Promise<VapidKeyPair> | null = null;
  #native: NativePush | null = null;

  constructor(opts: PushServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#sender = new WebPushSender({
      vapid: () => this.#vapid(null),
      subject: () => this.#subject(),
      now: this.#now,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.encrypt ? { encrypt: opts.encrypt } : {}),
    });
  }

  /** The Relay connector, for native apps; null turns that path off. */
  useNative(native: NativePush | null): void {
    this.#native = native;
  }

  // ---- VAPID -------------------------------------------------------------------------------

  /** The VAPID key, created on first use (audited for the account that caused it). */
  #vapid(accountId: string | null): Promise<VapidKeyPair> {
    this.#vapidKeys ??= (async () => {
      const stored = await this.#o.secrets.get(VAPID_SECRET_REF);
      if (stored) return vapidFromJwk(stored);
      const fresh = generateVapidKeys();
      await this.#o.secrets.put(VAPID_SECRET_REF, fresh.privateJwk);
      if (accountId)
        await this.#o.audit?.append({
          accountId,
          actor: 'system',
          kind: 'settings',
          action: 'push.vapid.create',
          resource: 'push:vapid',
        });
      return vapidFromJwk(fresh.privateJwk);
    })().catch((err: unknown) => {
      this.#vapidKeys = null;
      throw err;
    });
    return this.#vapidKeys;
  }

  /** The application server key browsers subscribe with (created on first use). */
  async vapidPublicKey(accountId: string): Promise<string> {
    return b64url((await this.#vapid(accountId)).publicKey);
  }

  async #subject(): Promise<string> {
    const configured = await this.#o.setting('push.vapidSubject');
    if (configured) return configured;
    const url = await this.#o.publicUrl?.().catch(() => null);
    if (url?.startsWith('https://')) return new URL(url).origin;
    return 'mailto:push@nova.invalid';
  }

  // ---- subscriptions -----------------------------------------------------------------------

  #rows(accountId: string): SubscriptionRow[] {
    return this.#db.raw
      .prepare('SELECT * FROM push_subscription WHERE account_id = ? ORDER BY created_at, id')
      .all(accountId) as unknown as SubscriptionRow[];
  }

  #view(r: SubscriptionRow): PushSubscriptionView {
    let origin = '';
    try {
      origin = new URL(r.endpoint).origin;
    } catch {
      // stored endpoints were checked; keep the view total anyway
    }
    return {
      id: r.id,
      kind: 'webpush',
      endpointOrigin: origin,
      label: r.label,
      deviceId: r.device_id,
      status: r.status,
      lastSuccessAt: r.last_success_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(accountId: string): PushSubscriptionView[] {
    return this.#rows(accountId).map((r) => this.#view(r));
  }

  async #checkEndpoint(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw fieldError('endpoint', 'not a URL');
    }
    const hosts = await this.#o.setting('push.webPushHosts');
    const problem = (this.#o.endpointProblem ?? endpointProblem)(url, hosts);
    if (problem) throw fieldError('endpoint', problem);
    return url;
  }

  /** Add or refresh the browser's subscription (the same endpoint replaces its keys). */
  async subscribe(
    accountId: string,
    req: CreatePushSubscriptionRequest,
    opts: { deviceId?: string | null } = {},
  ): Promise<PushSubscriptionView> {
    await this.#checkEndpoint(req.endpoint);
    const p256dh = fromB64url(req.keys.p256dh);
    const auth = fromB64url(req.keys.auth);
    const problem = subscriptionKeyProblem({ p256dh, auth });
    if (problem) throw fieldError('keys', problem);
    // Checked before anything is written (a huge value would make the date throw later).
    const exp = req.expirationTime;
    if (
      typeof exp === 'number' &&
      !(Number.isInteger(exp) && exp >= 0 && exp <= MAX_PUSH_EXPIRY_MS)
    )
      throw fieldError('expirationTime', 'not a time this subscription can expire at');
    const expires = typeof exp === 'number' ? new Date(exp).toISOString() : null;
    const now = this.#now().toISOString();
    const existing = this.#db.raw
      .prepare('SELECT * FROM push_subscription WHERE account_id = ? AND endpoint = ?')
      .get(accountId, req.endpoint) as SubscriptionRow | undefined;
    if (!existing && this.#rows(accountId).length >= MAX_SUBSCRIPTIONS)
      throw new NovaError(
        'conflict',
        `at most ${MAX_SUBSCRIPTIONS} push subscriptions; remove one`,
      );
    const id = existing?.id ?? uuidv7();
    const authRef = `secret://push/${id}/auth`;
    await this.#o.secrets.put(authRef, b64url(auth));
    await this.#db.transaction(() => {
      if (existing)
        this.#db.raw
          .prepare(
            `UPDATE push_subscription SET p256dh = ?, label = ?, device_id = ?, status = 'active',
               failures = 0, expires_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(
            b64url(p256dh),
            req.label ?? existing.label,
            opts.deviceId ?? existing.device_id,
            expires,
            now,
            id,
          );
      else
        this.#db.raw
          .prepare(
            `INSERT INTO push_subscription (id, account_id, device_id, endpoint, p256dh, auth_ref,
               label, status, failures, expires_at, last_success_at, last_error, created_at,
               updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            id,
            accountId,
            opts.deviceId ?? null,
            req.endpoint,
            b64url(p256dh),
            authRef,
            req.label ?? null,
            expires,
            now,
            now,
          );
    });
    const row = this.#db.raw
      .prepare('SELECT * FROM push_subscription WHERE id = ?')
      .get(id) as unknown as SubscriptionRow;
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'push.subscribe',
      resource: `push_subscription:${id}`,
      detail: { origin: this.#view(row).endpointOrigin, renewed: !!existing },
    });
    return this.#view(row);
  }

  async remove(accountId: string, id: string, actor = 'user'): Promise<void> {
    const row = this.#db.raw
      .prepare('SELECT * FROM push_subscription WHERE id = ? AND account_id = ?')
      .get(id, accountId) as SubscriptionRow | undefined;
    if (!row) throw new NovaError('not_found', 'push subscription not found');
    await this.#drop(row);
    await this.#o.audit?.append({
      accountId,
      actor,
      kind: 'settings',
      action: actor === 'user' ? 'push.unsubscribe' : 'push.subscription.gone',
      resource: `push_subscription:${id}`,
    });
  }

  /**
   * A revoked device's subscriptions go with it (docs/22 §4.5): rows and their auth secrets, each
   * audited as `push.subscription.gone` with the reason. Returns how many went.
   */
  async removeForDevice(
    accountId: string,
    deviceId: string,
    reason = 'device_revoked',
  ): Promise<number> {
    const rows = this.#db.raw
      .prepare('SELECT * FROM push_subscription WHERE account_id = ? AND device_id = ?')
      .all(accountId, deviceId) as unknown as SubscriptionRow[];
    for (const row of rows) {
      await this.#drop(row);
      await this.#o.audit?.append({
        accountId,
        actor: 'system',
        kind: 'settings',
        action: 'push.subscription.gone',
        resource: `push_subscription:${row.id}`,
        detail: { reason, deviceId },
      });
    }
    return rows.length;
  }

  async #drop(row: SubscriptionRow): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM push_subscription WHERE id = ?').run(row.id);
    });
    await this.#o.secrets.delete(row.auth_ref).catch(() => false);
  }

  // ---- sending -----------------------------------------------------------------------------

  /** The payload of a notification's push; never its body. */
  async payload(n: PushNotificationInput, detail?: PushDetailLevel): Promise<PushPayload> {
    const level = detail ?? (await this.#o.setting('push.detail'));
    return {
      v: 1,
      id: n.notificationId,
      category: n.kind,
      title: pushTitle(n.kind, n.title, n.href, level),
      path: n.href,
      link: deepLink(n.href),
      at: this.#now().toISOString(),
    };
  }

  /** The OS leg (FR-060): push the notification to every subscribed browser and native app. */
  async notify(n: PushNotificationInput): Promise<PushOutcome> {
    const out: PushOutcome = { webpush: { sent: 0, failed: 0, gone: 0 }, native: null };
    if (!(await this.#o.setting('push.enabled'))) return out;
    const payload = await this.payload(n);
    const rows = this.#rows(n.accountId).filter((r) => r.status !== 'gone');
    const results = await Promise.all(rows.map((r) => this.#pushOne(r, payload)));
    for (const r of results) out.webpush[r]++;
    if (this.#native) {
      // The Relay never gets more than the redacted title, whatever `push.detail` says.
      const level = (await this.#o.setting('push.detail')) === 'none' ? 'none' : 'redacted';
      try {
        out.native = await this.#native.pushNotify(n.accountId, {
          id: n.notificationId,
          category: n.kind,
          title: pushTitle(n.kind, n.title, n.href, level).slice(0, 80),
          link: payload.link,
        });
        if (out.native.sent || out.native.failed)
          await this.#record(
            n.accountId,
            n.notificationId,
            'relay',
            null,
            out.native.sent ? 'sent' : 'failed',
            `sent ${out.native.sent}, skipped ${out.native.skipped}, failed ${out.native.failed}`,
          );
      } catch (err) {
        out.native = { sent: 0, skipped: 0, failed: 1 };
        await this.#record(n.accountId, n.notificationId, 'relay', null, 'failed', errText(err));
      }
    }
    await this.#prune();
    return out;
  }

  async #pushOne(row: SubscriptionRow, payload: PushPayload): Promise<'sent' | 'failed' | 'gone'> {
    const now = this.#now().toISOString();
    let detail: string | null = null;
    let status: 'sent' | 'failed' | 'gone' = 'failed';
    try {
      await this.#checkEndpoint(row.endpoint);
      const auth = await this.#o.secrets.get(row.auth_ref);
      if (!auth) throw new Error('the subscription secret is missing');
      const res = await this.#sender.send({
        endpoint: row.endpoint,
        keys: { p256dh: fromB64url(row.p256dh), auth: fromB64url(auth) },
        payload: Buffer.from(JSON.stringify(payload)),
        ttlSeconds: payload.category === 'approval' ? 3600 : 24 * 3600,
        urgency: URGENCY[payload.category],
        // A newer push for the same notification replaces an undelivered one.
        topic: createHash('sha256').update(payload.id).digest('base64url').slice(0, 32),
      });
      status = res.ok ? 'sent' : res.gone ? 'gone' : 'failed';
      detail = res.detail;
    } catch (err) {
      detail = errText(err);
    }
    if (status === 'gone') {
      await this.#drop(row);
      await this.#o.audit?.append({
        accountId: row.account_id,
        actor: 'system',
        kind: 'settings',
        action: 'push.subscription.gone',
        resource: `push_subscription:${row.id}`,
        detail: { reason: detail },
      });
    } else
      await this.#db.transaction(() => {
        if (status === 'sent')
          this.#db.raw
            .prepare(
              `UPDATE push_subscription SET status = 'active', failures = 0, last_success_at = ?,
                 last_error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(now, now, row.id);
        else
          this.#db.raw
            .prepare(
              `UPDATE push_subscription SET failures = failures + 1,
                 status = CASE WHEN failures + 1 >= ? THEN 'failing' ELSE status END,
                 last_error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(FAILING_AFTER, detail, now, row.id);
      });
    await this.#record(row.account_id, payload.id, 'webpush', row.id, status, detail);
    return status;
  }

  /** POST /api/v1/push/test: a test push to each subscription (or one). */
  async test(accountId: string, subscriptionId?: string): Promise<PushTestView> {
    const rows = this.#rows(accountId).filter((r) => !subscriptionId || r.id === subscriptionId);
    if (subscriptionId && !rows.length)
      throw new NovaError('not_found', 'push subscription not found');
    const payload: PushPayload = {
      v: 1,
      id: uuidv7(),
      category: 'system',
      title: 'Test notification from Nova',
      path: '/settings/notifications',
      link: null,
      at: this.#now().toISOString(),
    };
    const results: PushTestView['results'] = [];
    for (const r of rows) {
      const status = await this.#pushOne(r, payload);
      const after = this.#db.raw
        .prepare('SELECT last_error FROM push_subscription WHERE id = ?')
        .get(r.id) as { last_error: string | null } | undefined;
      results.push({
        subscriptionId: r.id,
        status,
        detail: status === 'sent' ? null : (after?.last_error ?? 'gone'),
      });
    }
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'settings',
      action: 'push.test',
      resource: subscriptionId ? `push_subscription:${subscriptionId}` : 'push',
      detail: { sent: results.filter((r) => r.status === 'sent').length },
    });
    return {
      sent: results.filter((r) => r.status === 'sent').length,
      failed: results.filter((r) => r.status !== 'sent').length,
      results,
    };
  }

  /** Recent pushes (diagnostics and tests): where they went and how they ended. */
  deliveries(
    accountId: string,
    limit = 100,
  ): {
    notificationId: string | null;
    target: 'webpush' | 'relay';
    ref: string | null;
    status: string;
    detail: string | null;
  }[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT notification_id, target_kind, target_ref, status, detail FROM push_delivery
         WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(accountId, limit) as {
      notification_id: string | null;
      target_kind: 'webpush' | 'relay';
      target_ref: string | null;
      status: string;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      notificationId: r.notification_id,
      target: r.target_kind,
      ref: r.target_ref,
      status: r.status,
      detail: r.detail,
    }));
  }

  /** Counts for diagnostics. */
  counts(): { subscriptions: number; failing: number } {
    const n = (sql: string) => (this.#db.raw.prepare(sql).get() as { n: number }).n;
    return {
      subscriptions: n('SELECT count(*) AS n FROM push_subscription'),
      failing: n("SELECT count(*) AS n FROM push_subscription WHERE status = 'failing'"),
    };
  }

  async #record(
    accountId: string,
    notificationId: string | null,
    target: 'webpush' | 'relay',
    ref: string | null,
    status: 'sent' | 'failed' | 'gone' | 'skipped',
    detail: string | null,
  ): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO push_delivery (id, account_id, notification_id, target_kind, target_ref,
             status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uuidv7(),
          accountId,
          notificationId,
          target,
          ref,
          status,
          detail?.slice(0, 300) ?? null,
          this.#now().toISOString(),
        );
    });
  }

  async #prune(): Promise<void> {
    const before = new Date(this.#now().getTime() - DELIVERY_RETENTION_MS).toISOString();
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM push_delivery WHERE created_at < ?').run(before);
    });
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function fieldError(field: string, message: string): NovaError {
  return new NovaError('validation', message, { details: { field } });
}
