// MCP event subscriptions (FR-201, docs/09 §7, contracts/hub-api.md "MCP"). For a server that
// advertises events, an `mcp_event` trigger subscribes with the Hub's webhook URL
// (/api/v1/mcp/events/<subscription id>) and a fresh signing secret kept in the secret store;
// the subscription is refreshed before it expires and unsubscribed when it is removed. Deliveries
// must be signed (`x-nova-event-signature: sha256=` HMAC-SHA256 over `<id>.<timestamp>.<body>`,
// with `x-nova-event-id` and `x-nova-event-timestamp` inside the five-minute window) and at most
// 256 KiB. Accepted deliveries are recorded by id; a known id is answered 200 and starts nothing.
// Unsigned, stale, badly signed and oversized deliveries are refused and audited, never stored
// (docs/06 invariant 17). Payloads are untrusted (FR-103).
import { randomBytes } from 'node:crypto';
import {
  NovaError,
  uuidv7,
  type McpEventSourceView,
  type McpSubscriptionStatus,
  type McpSubscriptionView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { concat, freshTimestamp, headerOf, hmacHex, safeEqual, type Headers } from './signing.ts';
import type { FireOutcome, TriggerEvent, TriggerSubscriptions } from './triggers.ts';

/** The largest delivery body accepted (FR-201). */
export const MCP_DELIVERY_MAX_BYTES = 256 * 1024;
export const MCP_DELIVERY_HEADERS = {
  id: 'x-nova-event-id',
  timestamp: 'x-nova-event-timestamp',
  signature: 'x-nova-event-signature',
} as const;

/** `sha256=<hex>` over `<id>.<timestamp>.<body>`: what a server signs each delivery with. */
export function signMcpDelivery(
  secret: string,
  id: string,
  timestamp: string,
  body: string | Uint8Array,
): string {
  return `sha256=${hmacHex(secret, concat(id, '.', timestamp, '.', body))}`;
}

export interface McpEventInfo {
  name: string;
  description: string | null;
}

/**
 * The MCP client side (@nova/mcp `McpEventsClient` over the connection manager): what a server
 * advertises and the subscribe, refresh and unsubscribe calls.
 */
export interface McpEventSource {
  /** The events a connected server advertises; null when it is not connected. */
  events(serverId: string): McpEventInfo[] | null;
  subscribe(
    serverId: string,
    input: {
      event: string;
      webhookUrl: string;
      secret: string;
      filter: Record<string, unknown> | null;
      ttlSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<{ remoteId: string; expiresAt: string | null }>;
  refresh(
    serverId: string,
    remoteId: string,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<{ expiresAt: string | null }>;
  unsubscribe(serverId: string, remoteId: string, signal: AbortSignal): Promise<void>;
}

export interface SubscriptionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface McpEventServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  secrets: SecretStore;
  /** The Hub's public base URL (channels.publicUrl, else the Hub address). */
  webhookBase: () => Promise<string>;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  timers?: SubscriptionTimers;
  /** The lifetime asked for (default 24 h). */
  ttlSeconds?: number;
  /** How often pending, lapsed and expiring subscriptions are looked at (default 60 s). */
  tickMs?: number;
  /** Per-call timeout towards the server (default 15 s). */
  callTimeoutMs?: number;
}

/** What a delivery receives: an HTTP status and a body. */
export interface DeliveryOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface SubRow {
  id: string;
  account_id: string;
  mcp_server_id: string;
  trigger_id: string;
  event_name: string;
  remote_ref: string | null;
  webhook_secret_ref: string;
  filter_json: string | null;
  expires_at: string | null;
  refresh_before: string | null;
  status: McpSubscriptionStatus;
  last_delivery_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const DELIVERY_RETENTION_MS = 7 * 24 * 3_600_000;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export class McpEventService implements TriggerSubscriptions {
  readonly #o: McpEventServiceOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #timers: SubscriptionTimers;
  #source: McpEventSource | null = null;
  #fire: ((accountId: string, triggerId: string, e: TriggerEvent) => Promise<FireOutcome>) | null =
    null;
  #timer: unknown = null;
  #running = false;
  #ticking: Promise<void> | null = null;

  constructor(opts: McpEventServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  /** The MCP client's event calls; pending subscriptions are tried on the next tick. */
  useSource(source: McpEventSource): void {
    this.#source = source;
    if (this.#running) this.#schedule(0);
  }

  /** The trigger service's `fire`. */
  useTriggers(
    fire: (accountId: string, triggerId: string, e: TriggerEvent) => Promise<FireOutcome>,
  ): void {
    this.#fire = fire;
  }

  // ---- views --------------------------------------------------------------------------------

  #rowById(id: string): SubRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM mcp_event_subscription WHERE id = ?').get(id) as
        SubRow | undefined) ?? null
    );
  }

  #view(r: SubRow): McpSubscriptionView {
    let filter: Record<string, unknown> | null;
    try {
      filter = r.filter_json ? (JSON.parse(r.filter_json) as Record<string, unknown>) : null;
    } catch {
      filter = null;
    }
    return {
      id: r.id,
      triggerId: r.trigger_id,
      serverId: r.mcp_server_id,
      event: r.event_name,
      status: r.status,
      filter,
      expiresAt: r.expires_at,
      refreshBefore: r.refresh_before,
      lastDeliveryAt: r.last_delivery_at,
      lastError: r.last_error,
      webhookPath: `/api/v1/mcp/events/${r.id}`,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(accountId: string): McpSubscriptionView[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM mcp_event_subscription WHERE account_id = ? ORDER BY created_at, id')
      .all(accountId) as unknown as SubRow[];
    return rows.map((r) => this.#view(r));
  }

  get(accountId: string, id: string): McpSubscriptionView {
    const row = this.#rowById(id);
    if (!row || row.account_id !== accountId)
      throw new NovaError('not_found', 'subscription not found');
    return this.#view(row);
  }

  viewForTrigger(triggerId: string): McpSubscriptionView | null {
    const row = this.#db.raw
      .prepare(
        'SELECT * FROM mcp_event_subscription WHERE trigger_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(triggerId) as SubRow | undefined;
    return row ? this.#view(row) : null;
  }

  /** The account's servers that advertise events (connected ones only). */
  sources(accountId: string): McpEventSourceView[] {
    const servers = this.#db.raw
      .prepare('SELECT id, name FROM mcp_server WHERE account_id = ? ORDER BY name')
      .all(accountId) as { id: string; name: string }[];
    const out: McpEventSourceView[] = [];
    for (const s of servers) {
      const events = this.#source?.events(s.id) ?? null;
      if (events?.length) out.push({ serverId: s.id, name: s.name, events });
    }
    return out;
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Validate the server and event before a trigger is stored. */
  check(accountId: string, input: { serverId: string; event: string }): Promise<void> {
    const server = this.#db.raw
      .prepare('SELECT id, name FROM mcp_server WHERE id = ? AND account_id = ?')
      .get(input.serverId, accountId) as { id: string; name: string } | undefined;
    if (!server)
      return Promise.reject(
        new NovaError('validation', 'no such MCP server', { details: { field: 'serverId' } }),
      );
    const events = this.#source?.events(server.id) ?? null;
    // A server that is not connected now is checked when it connects.
    if (events && !events.some((e) => e.name === input.event))
      return Promise.reject(
        new NovaError('validation', `${server.name} does not offer the event ${input.event}`, {
          details: { field: 'event', offered: events.map((e) => e.name) },
        }),
      );
    return Promise.resolve();
  }

  async create(
    accountId: string,
    triggerId: string,
    input: { serverId: string; event: string; filter: Record<string, unknown> | null },
  ): Promise<McpSubscriptionView> {
    await this.check(accountId, input);
    const id = uuidv7();
    const secretRef = `secret://mcp/${input.serverId}/events/${id}`;
    await this.#o.secrets.put(secretRef, randomBytes(32).toString('hex'));
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO mcp_event_subscription (id, account_id, mcp_server_id, trigger_id, event_name,
             remote_ref, webhook_secret_ref, filter_json, expires_at, refresh_before, status,
             last_delivery_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          accountId,
          input.serverId,
          triggerId,
          input.event,
          secretRef,
          input.filter ? JSON.stringify(input.filter) : null,
          now,
          now,
        );
    });
    await this.#o.audit?.append({
      accountId,
      actor: 'user',
      kind: 'mcp',
      action: 'mcp.subscription.create',
      resource: `mcp_server:${input.serverId}`,
      detail: { subscriptionId: id, triggerId, event: input.event },
    });
    await this.#activate(this.#rowById(id)!);
    return this.#view(this.#rowById(id)!);
  }

  /**
   * DELETE /api/v1/mcp/subscriptions/:id: unsubscribe, keep the row as `removed` (the webhook then
   * answers 410) and turn its trigger off.
   */
  async remove(accountId: string, id: string): Promise<McpSubscriptionView> {
    const row = this.#rowById(id);
    if (!row || row.account_id !== accountId)
      throw new NovaError('not_found', 'subscription not found');
    if (row.status !== 'removed') {
      await this.#unsubscribe(row);
      await this.#setStatus(row, 'removed', { lastError: null });
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE trigger SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(this.#now().toISOString(), row.trigger_id);
      });
      await this.#o.secrets.delete(row.webhook_secret_ref).catch(() => false);
      await this.#o.audit?.append({
        accountId,
        actor: 'user',
        kind: 'mcp',
        action: 'mcp.subscription.remove',
        resource: `mcp_server:${row.mcp_server_id}`,
        detail: { subscriptionId: id, triggerId: row.trigger_id },
      });
    }
    return this.#view(this.#rowById(id)!);
  }

  /**
   * Before an MCP server is removed (the MCP area calls this while the connection still exists):
   * unsubscribe its subscriptions. The rows then go with the server (ON DELETE CASCADE).
   */
  async removeForServer(accountId: string, serverId: string): Promise<number> {
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM mcp_event_subscription WHERE mcp_server_id = ? AND account_id = ?
           AND status <> 'removed'`,
      )
      .all(serverId, accountId) as unknown as SubRow[];
    for (const row of rows) {
      await this.#unsubscribe(row);
      await this.#setStatus(row, 'removed', { lastError: null });
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE trigger SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(this.#now().toISOString(), row.trigger_id);
      });
    }
    return rows.length;
  }

  /** Before a trigger is deleted: unsubscribe its subscriptions (rows go with the trigger). */
  async removeForTrigger(accountId: string, triggerId: string): Promise<void> {
    const rows = this.#db.raw
      .prepare('SELECT * FROM mcp_event_subscription WHERE trigger_id = ? AND account_id = ?')
      .all(triggerId, accountId) as unknown as SubRow[];
    for (const row of rows) {
      if (row.status !== 'removed') await this.#unsubscribe(row);
      await this.#o.secrets.delete(row.webhook_secret_ref).catch(() => false);
      await this.#o.events.emit({
        name: 'mcp.subscription.changed',
        accountId: row.account_id,
        actor: 'user',
        payload: { subscriptionId: row.id, status: 'removed' },
      });
    }
  }

  async #unsubscribe(row: SubRow): Promise<void> {
    if (!row.remote_ref || !this.#source) return;
    try {
      await this.#source.unsubscribe(row.mcp_server_id, row.remote_ref, this.#signal());
    } catch (err) {
      // Best effort: the webhook refuses its deliveries from now on either way.
      this.#o.log?.warn('mcp unsubscribe failed', { err, subscriptionId: row.id });
    }
  }

  #signal(): AbortSignal {
    return AbortSignal.timeout(this.#o.callTimeoutMs ?? 15_000);
  }

  /** Subscribe a pending or lapsed subscription. */
  async #activate(row: SubRow): Promise<void> {
    const source = this.#source;
    if (!source) {
      await this.#setStatus(row, 'pending', {
        lastError: 'MCP event subscriptions are not available yet',
      });
      return;
    }
    const events = source.events(row.mcp_server_id);
    if (events === null) {
      await this.#setStatus(row, row.status === 'lapsed' ? 'lapsed' : 'pending', {
        lastError: 'the MCP server is not connected',
      });
      return;
    }
    if (!events.some((e) => e.name === row.event_name)) {
      await this.#setStatus(row, 'failed', {
        lastError: `the server does not offer the event ${row.event_name}`,
      });
      return;
    }
    const secret = await this.#o.secrets.get(row.webhook_secret_ref);
    if (!secret) {
      await this.#setStatus(row, 'failed', { lastError: 'the signing secret is missing' });
      return;
    }
    try {
      const base = (await this.#o.webhookBase()).replace(/\/+$/, '');
      const res = await source.subscribe(
        row.mcp_server_id,
        {
          event: row.event_name,
          webhookUrl: `${base}/api/v1/mcp/events/${row.id}`,
          secret,
          filter: row.filter_json ? (JSON.parse(row.filter_json) as Record<string, unknown>) : null,
          ttlSeconds: this.#ttl(),
        },
        this.#signal(),
      );
      await this.#setStatus(row, 'active', {
        remoteRef: res.remoteId,
        expiresAt: res.expiresAt,
        lastError: null,
      });
    } catch (err) {
      await this.#setStatus(row, row.status === 'lapsed' ? 'lapsed' : 'pending', {
        lastError: errText(err),
      });
    }
  }

  async #refresh(row: SubRow): Promise<void> {
    const source = this.#source;
    if (!source || !row.remote_ref) return this.#activate(row);
    await this.#setStatus(row, 'refreshing', {});
    try {
      const res = await source.refresh(
        row.mcp_server_id,
        row.remote_ref,
        this.#ttl(),
        this.#signal(),
      );
      await this.#setStatus(this.#rowById(row.id) ?? row, 'active', {
        expiresAt: res.expiresAt,
        lastError: null,
      });
    } catch (err) {
      const current = this.#rowById(row.id) ?? row;
      const expired =
        current.expires_at !== null && Date.parse(current.expires_at) <= this.#now().getTime();
      await this.#setStatus(current, expired ? 'lapsed' : 'refreshing', {
        lastError: errText(err),
      });
    }
  }

  #ttl(): number {
    return this.#o.ttlSeconds ?? 86_400;
  }

  /** Refresh from three quarters of the lifetime on, and at least five minutes before expiry. */
  #refreshBefore(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const end = Date.parse(expiresAt);
    const now = this.#now().getTime();
    if (!Number.isFinite(end)) return null;
    const lead = Math.max(5 * 60_000, (end - now) / 4);
    return new Date(Math.max(now, end - lead)).toISOString();
  }

  async #setStatus(
    row: SubRow,
    status: McpSubscriptionStatus,
    f: { remoteRef?: string | null; expiresAt?: string | null; lastError?: string | null },
  ): Promise<void> {
    const now = this.#now().toISOString();
    const expiresAt = f.expiresAt === undefined ? row.expires_at : f.expiresAt;
    const refreshBefore =
      f.expiresAt === undefined ? row.refresh_before : this.#refreshBefore(f.expiresAt);
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE mcp_event_subscription SET status = ?, remote_ref = ?, expires_at = ?,
             refresh_before = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          status,
          f.remoteRef === undefined ? row.remote_ref : f.remoteRef,
          expiresAt,
          refreshBefore,
          f.lastError === undefined ? row.last_error : f.lastError,
          now,
          row.id,
        );
    });
    if (status !== row.status)
      await this.#o.events.emit({
        name: 'mcp.subscription.changed',
        accountId: row.account_id,
        actor: 'system',
        payload: {
          subscriptionId: row.id,
          status,
          ...(expiresAt ? { expiresAt } : {}),
        },
      });
  }

  /** One pass: subscribe pending and lapsed ones, refresh expiring ones, mark expired ones. */
  async tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = (async () => {
      const now = this.#now();
      const iso = now.toISOString();
      const rows = this.#db.raw
        .prepare(
          `SELECT * FROM mcp_event_subscription
           WHERE status IN ('pending', 'lapsed')
              OR (status IN ('active', 'refreshing') AND (refresh_before IS NOT NULL AND refresh_before <= ?
                  OR expires_at IS NOT NULL AND expires_at <= ?))
           ORDER BY created_at`,
        )
        .all(iso, iso) as unknown as SubRow[];
      for (const row of rows) {
        try {
          if (row.status === 'pending' || row.status === 'lapsed') await this.#activate(row);
          else await this.#refresh(row);
        } catch (err) {
          this.#o.log?.warn('mcp subscription upkeep failed', { err, subscriptionId: row.id });
        }
      }
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('DELETE FROM mcp_event_delivery WHERE received_at < ?')
          .run(new Date(now.getTime() - DELIVERY_RETENTION_MS).toISOString());
      });
    })().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  #schedule(ms: number): void {
    if (!this.#running) return;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.tick()
        .catch((err: unknown) => this.#o.log?.warn('mcp subscription tick failed', { err }))
        .finally(() => this.#schedule(this.#o.tickMs ?? 60_000));
    }, ms);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#ticking;
  }

  // ---- deliveries ---------------------------------------------------------------------------

  /** POST /api/v1/mcp/events/:subscriptionId (public; the signature authenticates it). */
  async receive(
    subscriptionId: string,
    req: { headers: Headers; rawBody: Uint8Array },
  ): Promise<DeliveryOutcome> {
    const row = this.#rowById(subscriptionId);
    if (!row || row.status === 'removed')
      return { status: 410, body: error('gone', 'this subscription was removed') };
    const size = req.rawBody.byteLength;
    if (size > MCP_DELIVERY_MAX_BYTES) return this.#reject(row, 413, 'too_large', size);
    const id = headerOf(req.headers, MCP_DELIVERY_HEADERS.id);
    const ts = headerOf(req.headers, MCP_DELIVERY_HEADERS.timestamp);
    const sig = headerOf(req.headers, MCP_DELIVERY_HEADERS.signature);
    if (!id || !ts || !sig || id.length > 200) return this.#reject(row, 401, 'unsigned', size);
    if (!freshTimestamp(ts, this.#now().getTime())) return this.#reject(row, 401, 'stale', size);
    const secret = await this.#o.secrets.get(row.webhook_secret_ref);
    if (!secret || !safeEqual(signMcpDelivery(secret, id, ts, req.rawBody), sig))
      return this.#reject(row, 401, 'bad_signature', size);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(req.rawBody).toString('utf8')) as unknown;
    } catch {
      return this.#reject(row, 400, 'not_json', size);
    }
    const now = this.#now().toISOString();
    const fresh = await this.#db.transaction(() =>
      Number(
        this.#db.raw
          .prepare(
            `INSERT OR IGNORE INTO mcp_event_delivery (subscription_id, delivery_id, size_bytes, run_id,
               received_at) VALUES (?, ?, ?, NULL, ?)`,
          )
          .run(row.id, id, size, now).changes,
      ),
    );
    const announce = (duplicate: boolean) =>
      this.#o.events.emit({
        name: 'mcp.event.received',
        accountId: row.account_id,
        actor: 'system',
        payload: {
          subscriptionId: row.id,
          triggerId: row.trigger_id,
          eventName: row.event_name,
          deliveryId: id,
          duplicate,
          sizeBytes: size,
        },
      });
    if (!fresh) {
      await announce(true);
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE mcp_event_subscription SET last_delivery_at = ? WHERE id = ?')
        .run(now, row.id);
    });
    await announce(false);
    let outcome: FireOutcome = { status: 'skipped', reason: 'no triggers' };
    if (this.#fire) {
      const server = this.#db.raw
        .prepare('SELECT name FROM mcp_server WHERE id = ?')
        .get(row.mcp_server_id) as { name: string } | undefined;
      outcome = await this.#fire(row.account_id, row.trigger_id, {
        dedupeKey: `mcp:${id}`,
        payload,
        origin: 'mcp',
        source: `the MCP server ${server?.name ?? row.mcp_server_id} (event ${row.event_name})`,
      }).catch((err: unknown): FireOutcome => ({ status: 'failed', reason: errText(err) }));
      if (outcome.runId)
        await this.#db.transaction(() => {
          this.#db.raw
            .prepare(
              'UPDATE mcp_event_delivery SET run_id = ? WHERE subscription_id = ? AND delivery_id = ?',
            )
            .run(outcome.runId!, row.id, id);
        });
    }
    return {
      status: 200,
      body: { ok: true, duplicate: false, outcome: outcome.status, runId: outcome.runId ?? null },
    };
  }

  async #reject(
    row: SubRow,
    status: number,
    reason: string,
    size: number,
  ): Promise<DeliveryOutcome> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE mcp_event_subscription SET last_error = ?, updated_at = ? WHERE id = ?')
        .run(`a delivery was refused: ${reason}`, this.#now().toISOString(), row.id);
    });
    await this.#o.audit?.append({
      accountId: row.account_id,
      actor: 'system',
      kind: 'mcp',
      action: 'mcp.event.rejected',
      resource: `mcp_server:${row.mcp_server_id}`,
      result: reason,
      detail: { subscriptionId: row.id, sizeBytes: size },
    });
    const messages: Record<string, string> = {
      too_large: `deliveries are limited to ${MCP_DELIVERY_MAX_BYTES} bytes`,
      unsigned: 'the delivery is not signed',
      stale: 'the delivery timestamp is outside the allowed window',
      bad_signature: 'the signature does not match',
      not_json: 'the delivery is not JSON',
    };
    const code = status === 413 ? 'too_large' : status === 400 ? 'validation' : 'token_required';
    return { status, body: error(code, messages[reason] ?? reason) };
  }
}

function error(code: string, message: string): Record<string, unknown> {
  return { error: { code, message, retryable: false } };
}
